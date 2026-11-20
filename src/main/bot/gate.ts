import type { CoinProfile } from '@shared/backtest'
import { breakerExit, m6Exit, msnrExit, trendExit, type BotConfig, type ExitConfig, type RiskConfig, type SmcConfig } from '@shared/config'
import type { ScreenerRow, ScreenerSetup } from '@shared/screener'
import { MODEL_LABEL, poiConcept, setupPoiLabel } from '@shared/smc'
import { TF_MS, type Timeframe } from '@shared/timeframes'

export interface AnalysisLite {
  id: string
  createdAt: number
  bias: 'long' | 'short' | 'skip'
  confidence: number
  forcedSkip: boolean
}

/** One setup of a screener row (the bot looks at every active setup, not only the best). */
export type Candidate = ScreenerRow & { setup: ScreenerSetup }

/** Every active setup of every row as a candidate. */
export const candidatesOf = (rows: readonly ScreenerRow[]): Candidate[] => rows.flatMap((r) => (r.setups ?? (r.setup ? [r.setup] : [])).map((s) => ({ ...r, setup: s })))

/** Pending limits are cancelled when price reaches this first (same rule as the backtest). */
export const cancelLevel = (s: Pick<ScreenerSetup, 'entry' | 'sl' | 'tp' | 'tpLiquidity'>, exit: Pick<ExitConfig, 'tpMode'> & Partial<Pick<ExitConfig, 'tpR'>>): number => {
  if (exit.tpMode === 'trail') return s.tpLiquidity ?? s.tp
  if (exit.tpMode === 'fixedR' && exit.tpR !== undefined) return planTpFor(s, s.sl < s.entry, { tpMode: 'fixedR', tpR: exit.tpR })!
  return s.tp
}

/**
 * Exit plan for a setup: the coin profile's plan (chosen in the backtest Meta table) wins; without one,
 * M5 (trend) uses its own trailing-only plan and the SMC models use the global `exit` config.
 */
export function exitFor<E extends ExitConfig>(
  model: string,
  base: E,
  profile: CoinProfile | null | undefined,
  smc: Pick<SmcConfig, 'trendTrailGapR' | 'trendTrailStepR' | 'breakerTpR' | 'm6TrailGapR' | 'm6TrailStepR'>
): E {
  if (profile) return { ...base, ...profile.plan.exit }
  if (model === 'M5') return { ...base, ...trendExit(smc) }
  if (model === 'M6') return { ...base, ...m6Exit(smc) }
  if (model === 'M7') return { ...base, ...msnrExit() }
  const bx = model === 'M4' ? breakerExit(smc) : null
  if (bx) return { ...base, ...bx }
  return base
}

const POI_TF_MODELS = new Set<string>(['M0', 'M1', 'M2a', 'M2b'])

/** When the setup became known: close of the OB valid confirmation candle. */
export const knownAt = (c: Candidate, entryTf: Timeframe): number => c.setup.createdT + TF_MS[entryTf]

/**
 * Setup-level rules (no Claude, no account state): model allowed, required confluences, score,
 * parent POI timeframe (M1/M2b), still pending, fresh, and price hasn't reached the TP or the entry.
 */
export function setupGate(
  c: Candidate,
  o: { bot: BotConfig; entryTf: Timeframe; universe: ReadonlySet<string>; now: number; exit?: Pick<ExitConfig, 'tpMode'> & Partial<Pick<ExitConfig, 'tpR'>>; profile?: CoinProfile | null; smc?: Pick<SmcConfig, 'breakerTpR'> }
): string | null {
  const s = c.setup
  const bull = c.direction === 'bullish'
  const p = o.profile ?? null
  if (!o.universe.has(c.symbol)) return `bukan top ${o.bot.topVolume} crypto by volume`
  const models: string[] = p ? p.models : o.bot.models
  if (!models.includes(s.model)) return `${MODEL_LABEL[s.model]} tidak dipakai bot${p ? ` (profil ${c.symbol})` : ''}`
  const pk = `${poiConcept(s.model, s.poi.kind)}|${s.poi.timeframe}`
  // profiles saved before breakers had their own key stored M4 as "OB|tf"
  if (p && p.pois.length && !p.pois.includes(pk) && !(s.model === 'M4' && p.pois.includes(`OB|${s.poi.timeframe}`)))
    return `POI ${setupPoiLabel(s.model, s.poi.kind)} ${s.poi.timeframe} bukan POI profil ${c.symbol}`
  // SMC models whose POI is the reason (M4 breakers, M5 trend and M6 radar are not limited)
  if (!p?.pois.length && POI_TF_MODELS.has(s.model) && !(o.bot.poiTimeframes as string[]).includes(s.poi.timeframe))
    return `POI ${setupPoiLabel(s.model, s.poi.kind)} ${s.poi.timeframe} bukan HTF (${o.bot.poiTimeframes.join('/')})`
  // every model has its own required list (a profile, saved from one model, has one)
  const required = p ? p.requireConfluence : (o.bot.modelConfluence[s.model] ?? [])
  const missing = required.filter((k) => !(s.confluence as string[]).includes(k))
  if (missing.length) return `belum ada konfluensi wajib: ${missing.join(', ')}`
  const minScore = p ? p.minScore : o.bot.minScore
  if (s.score < minScore) return `skor ${s.score} < ${minScore}`
  if (s.status !== 'pending') return 'entry sudah kena sebelum bot sempat pasang limit'
  const age = o.now - knownAt(c, o.entryTf)
  if (age > o.bot.maxSetupAgeMin * 60_000) return `setup sudah ${Math.round(age / 60_000)} menit (maks ${o.bot.maxSetupAgeMin})`
  const bx = s.model === 'M4' && o.smc ? breakerExit(o.smc) : null
  const tp = cancelLevel(s, p ? p.plan.exit : s.model === 'M5' || s.model === 'M6' ? { tpMode: 'trail' } : s.model === 'M7' ? msnrExit() : (bx ?? o.exit ?? { tpMode: 'liquidity' }))
  if (bull ? c.price >= tp : c.price <= tp) return 'harga sudah sampai TP (lewat TP)'
  if (bull ? c.price <= s.entry : c.price >= s.entry) return 'harga sudah di/lewat entry'
  return null
}

/** Claude gate: newest analysis for the symbol, made after the setup was known. */
export function claudeGate(
  c: Candidate,
  a: AnalysisLite | null,
  o: { bot: BotConfig; entryTf: Timeframe; now: number }
): { ok: true } | { ok: false; reason: string; request: boolean } {
  if (!a || a.createdAt < knownAt(c, o.entryTf)) return { ok: false, reason: 'menunggu analisis Claude', request: true }
  if (o.now - a.createdAt > o.bot.maxAnalysisAgeMin * 60_000) return { ok: false, reason: 'analisis Claude sudah basi', request: true }
  if (a.forcedSkip) return { ok: false, reason: 'output Claude gagal validasi (forced skip)', request: false }
  const want = c.direction === 'bullish' ? 'long' : 'short'
  if (a.bias !== want) return { ok: false, reason: `bias Claude ${a.bias}, setup ${want}`, request: false }
  if (a.confidence < o.bot.minConfidence) return { ok: false, reason: `confidence ${a.confidence} < ${o.bot.minConfidence}`, request: false }
  return { ok: true }
}

/** Account-level blocks for any new entry. */
export function accountGate(o: {
  killSwitch: boolean
  newsWindow: string | null
  newsStrategy: boolean
  activeTrades: number
  risk: RiskConfig
  pnlToday: number
  equityDayStart: number | null
}): string | null {
  if (o.killSwitch) return 'Kill Switch aktif'
  if (o.equityDayStart !== null && o.pnlToday <= -o.equityDayStart * (o.risk.maxDailyLossPct / 100))
    return `rugi hari ini ${o.pnlToday.toFixed(2)} USDT ≥ batas ${o.risk.maxDailyLossPct}% → berhenti sampai 00:00 UTC`
  if (o.newsWindow && !o.newsStrategy) return `news window: ${o.newsWindow}`
  if (o.activeTrades >= o.risk.maxOpenPositions) return `posisi/order aktif sudah ${o.activeTrades} (maks ${o.risk.maxOpenPositions})`
  return null
}

/** Too many active trades (pending + open) already on this side (bot.maxSameDirection; 0 = off). */
export function directionGate(active: readonly { direction: 'bullish' | 'bearish' }[], dir: 'bullish' | 'bearish', max: number): string | null {
  if (max <= 0) return null
  const n = active.filter((t) => t.direction === dir).length
  return n >= max ? `sudah ${n} posisi/order ${dir === 'bullish' ? 'LONG' : 'SHORT'} aktif (maks ${max} searah)` : null
}

/** Planned TP for a setup under an exit plan (null = no TP order). */
export function planTpFor(s: Pick<ScreenerSetup, 'entry' | 'sl' | 'tp' | 'tpLiquidity'>, bull: boolean, exit: Pick<ExitConfig, 'tpMode' | 'tpR'>): number | null {
  const risk = Math.abs(s.entry - s.sl)
  const at = (r: number): number => (bull ? s.entry + r * risk : s.entry - r * risk)
  if (exit.tpMode === 'trail') return null
  if (exit.tpMode === 'fixedR') return at(exit.tpR)
  return s.tpLiquidity ?? at(exit.tpR)
}
