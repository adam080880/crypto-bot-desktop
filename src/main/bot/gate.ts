import type { BotConfig, RiskConfig } from '@shared/config'
import type { ScreenerRow } from '@shared/screener'
import { TF_MS, type Timeframe } from '@shared/timeframes'

export interface AnalysisLite {
  id: string
  createdAt: number
  bias: 'long' | 'short' | 'skip'
  confidence: number
  forcedSkip: boolean
}

/** Setup facts the bot needs (from a screener row). */
export type Candidate = ScreenerRow & { setup: NonNullable<ScreenerRow['setup']> }

/** When the setup became known: close of the OB valid confirmation candle. */
export const knownAt = (c: Candidate, entryTf: Timeframe): number => c.setup.createdT + TF_MS[entryTf]

/**
 * Setup-level rules (no Claude, no account state). HTF POI → OB valid on the entry TF, still
 * pending, fresh, and price hasn't reached the TP or the entry yet.
 */
export function setupGate(c: Candidate, o: { bot: BotConfig; entryTf: Timeframe; universe: ReadonlySet<string>; now: number }): string | null {
  const s = c.setup
  const bull = c.direction === 'bullish'
  if (!o.universe.has(c.symbol)) return `bukan top ${o.bot.topVolume} crypto by volume`
  if (!(o.bot.poiTimeframes as string[]).includes(s.poi.timeframe)) return `POI ${s.poi.timeframe} bukan HTF (${o.bot.poiTimeframes.join('/')})`
  if (s.status !== 'pending') return 'entry sudah kena sebelum bot sempat pasang limit'
  const age = o.now - knownAt(c, o.entryTf)
  if (age > o.bot.maxSetupAgeMin * 60_000) return `setup sudah ${Math.round(age / 60_000)} menit (maks ${o.bot.maxSetupAgeMin})`
  if (bull ? c.price >= s.tp : c.price <= s.tp) return 'harga sudah sampai TP (lewat TP)'
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
