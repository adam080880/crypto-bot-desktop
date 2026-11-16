import type { Candle } from '@shared/candles'
import { breakerExit, type ExitConfig, type SmcConfig } from '@shared/config'
import type { Confluence, Dir, EntryModel, PoiKind, PoiOrigin, Setup, SetupStatus } from '@shared/smc'
import { POI_LABEL } from '@shared/smc'
import { TF_MS, type Timeframe } from '@shared/timeframes'
import type { SmcAnalysisFull } from './analyze'
import { bodyHi, bodyLo } from './candle'
import type { OrderBlockIdx } from './orderBlocks'
import type { Pivot } from './swings'
import { atrSeries, emaSeries } from './atr'
import { flowConfluence, type FlowData } from './flow'
import { RADAR_BARS, volRatioSeries } from '../radar/radar'
import { wyckoffAt } from './wyckoff'
import { bbMomentumAt, bollinger, inTradeZone, rangePosition, type Bollinger } from './premium'

/** A point of interest from any timeframe, normalised. */
export interface Poi {
  kind: PoiKind
  timeframe: Timeframe
  direction: Dir
  level: number
  t: number
  /** Close time of the candle that made the POI known (no look-ahead). */
  activeFrom: number
  /** Open time of the candle that invalidated it on its own timeframe. */
  invalidT: number | null
  /** Why the POI formed (null = no sweep and no HTF tap → not tradable as a reason). */
  origin: PoiOrigin | null
}

const closeTime = (t: number, tf: Timeframe): number => t + TF_MS[tf]
const TF_RANK: Record<Timeframe, number> = { '1m': 0, '5m': 1, '15m': 2, '1h': 3, '4h': 4, '1d': 5, '1w': 6 }

/** First index with candle open time ≥ t (binary search). */
export function indexAtOrAfter(c: readonly Candle[], t: number): number {
  let lo = 0
  let hi = c.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (c[mid]!.t < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Index of the last candle that has closed by time `t` (−1 if none). */
const lastClosedBy = (c: readonly Candle[], tf: Timeframe, t: number): number => indexAtOrAfter(c, t - TF_MS[tf] + 1) - 1

// ---------------------------------------------------------------------------------------------
// POIs + origin
// ---------------------------------------------------------------------------------------------

interface RawPoi extends Poi {
  /** Candle (own TF) whose reaction created the POI: checked for sweep / HTF tap. */
  originIdx: number
  /** QM: mountain 2 takes mountain 1's liquidity by definition. */
  inherentSweep: boolean
}

/** Extreme (lowest low for bullish, highest high for bearish) in [from, to]. */
function extremeIdx(c: readonly Candle[], from: number, to: number, bull: boolean): number {
  let e = Math.max(0, from)
  for (let m = e; m <= Math.min(to, c.length - 1); m++) if (bull ? c[m]!.l < c[e]!.l : c[m]!.h > c[e]!.h) e = m
  return e
}

function rawPois(a: SmcAnalysisFull): RawPoi[] {
  const tf = a.timeframe
  const c = a.candles
  const idx = (t: number): number => indexAtOrAfter(c, t)
  const out: RawPoi[] = []
  const base = { timeframe: tf, origin: null, inherentSweep: false }
  for (const ob of a.orderBlocksIdx)
    out.push({ ...base, kind: 'OB', direction: ob.direction, level: ob.line, t: ob.t, activeFrom: closeTime(ob.confirmedT, tf), invalidT: ob.invalidT, originIdx: ob.i })
  for (const f of a.srFlips) {
    const bull = f.direction === 'bullish'
    // the leg that broke the level started at the extreme between the source swing and the break
    const e = extremeIdx(c, idx(f.sourceT), idx(f.breakT), bull)
    out.push({ ...base, kind: f.kind, direction: f.direction, level: f.level, t: f.sourceT, activeFrom: closeTime(f.breakT, tf), invalidT: f.invalidT, originIdx: e })
  }
  for (const q of a.qms)
    out.push({ ...base, kind: 'QM', direction: q.direction, level: q.level, t: q.points.h1, activeFrom: closeTime(q.activeT, tf), invalidT: q.invalidT, originIdx: idx(q.points.h2), inherentSweep: true })
  for (const o of a.ocls) {
    const i = idx(o.t)
    const bull = o.direction === 'bullish'
    if (o.kind === 'OCL')
      out.push({ ...base, kind: 'OCL', direction: o.direction, level: o.level, t: o.t, activeFrom: closeTime(o.t, tf) + TF_MS[tf], invalidT: o.invalidT, originIdx: extremeIdx(c, i - 2, i + 1, bull) })
    else if (o.breakT !== null)
      out.push({ ...base, kind: 'OCL_BREAK', direction: o.direction, level: o.level, t: o.t, activeFrom: closeTime(o.breakT, tf), invalidT: o.invalidT, originIdx: extremeIdx(c, i, idx(o.breakT), bull) })
  }
  return out
}

/** Did candle `e` sweep one of the last `n` swings on its side (unswept until then)? */
export function sweptSwing(c: readonly Candle[], pivots: readonly Pivot[], e: number, bull: boolean, n: number, lookback = 300): Pivot | null {
  const x = c[e]
  if (!x) return null
  let seen = 0
  for (let k = pivots.length - 1; k >= 0 && seen < n; k--) {
    const p = pivots[k]!
    if (p.kind !== (bull ? 'low' : 'high') || p.i >= e || p.confirmedAt > e) continue
    if (e - p.i > lookback) break
    seen++
    if (bull ? x.l >= p.price : x.h <= p.price) continue
    let clean = true
    for (let m = p.i + 1; m < e && clean; m++) if (bull ? c[m]!.l < p.price : c[m]!.h > p.price) clean = false
    if (clean) return p
  }
  return null
}

/** Did candle `e` (of `tf`) react at an active POI of a higher timeframe in the same direction? */
function tappedHtf(x: Candle, tf: Timeframe, bull: boolean, higher: readonly Poi[], nearPct: number): boolean {
  const near = nearPct / 100
  const known = closeTime(x.t, tf)
  for (const p of higher) {
    if ((p.direction === 'bullish') !== bull || p.activeFrom > known) continue
    if (p.invalidT !== null && p.invalidT <= x.t) continue
    if (bull ? x.l <= p.level * (1 + near) && x.c >= p.level * (1 - near) : x.h >= p.level * (1 - near) && x.c <= p.level * (1 + near)) return true
  }
  return false
}

const joinOrigin = (sweep: boolean, htf: boolean): PoiOrigin | null => (sweep && htf ? 'sweep+htfPoi' : sweep ? 'sweep' : htf ? 'htfPoi' : null)

/**
 * Every POI of every analysis, with its origin (docs/entry-v2.md: "a POI must be created by
 * something": a liquidity sweep or a tap of a higher-TF POI).
 */
export function collectAllPois(analyses: readonly SmcAnalysisFull[], cfg: Pick<SmcConfig, 'originNearPct' | 'originSwings'>): Poi[] {
  const sorted = [...analyses].sort((a, b) => TF_RANK[b.timeframe] - TF_RANK[a.timeframe])
  const done: Poi[] = []
  for (const a of sorted) {
    const higher = done.filter((p) => TF_RANK[p.timeframe] > TF_RANK[a.timeframe])
    for (const r of rawPois(a)) {
      const bull = r.direction === 'bullish'
      const x = a.candles[r.originIdx]
      const sweep = r.inherentSweep || sweptSwing(a.candles, a.pivots, r.originIdx, bull, cfg.originSwings) !== null
      const htf = !!x && tappedHtf(x, a.timeframe, bull, higher, cfg.originNearPct)
      const { originIdx: _i, inherentSweep: _s, ...poi } = r
      done.push({ ...poi, origin: joinOrigin(sweep, htf) })
    }
  }
  return done
}

/** POIs of one analysis without origin (kept for callers that only need levels). */
export function collectPois(a: SmcAnalysisFull): Poi[] {
  return rawPois(a).map(({ originIdx: _i, inherentSweep: _s, ...p }) => p)
}

// ---------------------------------------------------------------------------------------------
// Setups
// ---------------------------------------------------------------------------------------------

type TrendSrc = Pick<SmcAnalysisFull, 'timeframe' | 'trendChanges'>

export interface SetupInput {
  symbol: string
  entry: SmcAnalysisFull
  /** Higher-timeframe analyses providing POIs (1d, 4h, 1h by default). */
  poiAnalyses: readonly SmcAnalysisFull[]
  cfg: SmcConfig
  /** TP plan (only tpMode/tpR matter here). Default: liquidity with 5R fallback. */
  exit?: Pick<ExitConfig, 'tpMode' | 'tpR'>
  /** BTC trend sources for the score (omit for none). */
  btc?: { '4h'?: TrendSrc; '1h'?: TrendSrc }
  /** Open interest / funding of this symbol (omit for none → no flow tags). */
  flow?: FlowData
}

interface Draft {
  model: EntryModel
  dir: Dir
  poi: Setup['poi']
  child: Setup['child']
  entry: number
  sl: number
  /** Entry-TF index on whose close the setup is known; the order is followed from the next candle. */
  knownIdx: number
  /** Close beyond this before the fill → invalid. */
  invalidLevel: number
  confluence: Confluence[]
  reasons: string[]
  /** Pending expiry in entry candles (default cfg.setupExpiryCandles). */
  expiry?: number
}

/**
 * Entry models of docs/entry-v2.md. Entries only at an OB, QM or breaker; FVG is information.
 * Every model reports a pending limit order that is then followed on the entry TF:
 * pending → triggered → win/loss (by the planned SL/TP), or missed/invalid/expired.
 */
export function detectSetups(input: SetupInput): Setup[] {
  const { entry, poiAnalyses, cfg } = input
  const c = entry.candles
  if (!c.length) return []
  const models = new Set(cfg.models)
  const all = [entry, ...poiAnalyses.filter((a) => a.timeframe !== entry.timeframe)]
  const pois = collectAllPois(all, cfg)
  const drafts: Draft[] = []

  if (models.has('M0')) drafts.push(...modelM0(input, pois))
  if (models.has('M1')) drafts.push(...modelM1(input, pois))
  if (models.has('M2a') || models.has('M2b')) drafts.push(...modelM2(input, all, pois, models))
  if (models.has('M4')) drafts.push(...modelM4(input, all))
  if (models.has('M5')) drafts.push(...modelM5(input, all))
  if (models.has('M6')) drafts.push(...modelM6(input, all))

  const atr = cfg.minSlAtr > 0 ? atrSeries(c, 14) : null
  const h1 = all.find((a) => a.timeframe === '1h')
  const vol1h = h1 && h1.candles.length >= RADAR_BARS ? { c: h1.candles, vr: volRatioSeries(h1.candles) } : null
  const best = new Map<string, Setup>()
  for (const d0 of drafts) {
    const d = atr && d0.model !== 'M5' && d0.model !== 'M6' ? widenSl(d0, cfg.minSlAtr * atr[Math.min(d0.knownIdx, c.length - 1)]!) : d0
    const s = finalize(input, all, d, vol1h)
    if (!s) continue
    const prev = best.get(s.id)
    if (!prev || s.score > prev.score) best.set(s.id, s)
  }
  return [...best.values()].sort((a, b) => a.createdT - b.createdT || a.id.localeCompare(b.id))
}

/** SL at least `min` away from the entry (ATR floor); the invalidation level stays where it was. */
function widenSl(d: Draft, min: number): Draft {
  if (!(Math.abs(d.entry - d.sl) < min)) return d
  return { ...d, sl: d.dir === 'bullish' ? d.entry - min : d.entry + min }
}

/** Parent POIs allowed as the reason of a trade. */
function parentPois(input: SetupInput, pois: readonly Poi[]): Poi[] {
  const { cfg, entry } = input
  const tfs = new Set<Timeframe>(cfg.poiTimeframes)
  if (cfg.sameTfPoi) tfs.add(entry.timeframe)
  return pois.filter(
    (p) =>
      tfs.has(p.timeframe) &&
      (p.kind !== 'OCL' || (cfg.oclParentTimeframes as Timeframe[]).includes(p.timeframe)) &&
      (!cfg.parentNeedsOrigin || p.origin !== null)
  )
}

/** First entry-TF touch of a POI while it is still valid (−1 if none). */
function firstTouch(c: readonly Candle[], poi: Poi, fromT = poi.activeFrom): number {
  const bull = poi.direction === 'bullish'
  for (let m = indexAtOrAfter(c, fromT); m < c.length; m++) {
    if (poi.invalidT !== null && c[m]!.t >= closeTime(poi.invalidT, poi.timeframe)) return -1
    if (bull ? c[m]!.l <= poi.level : c[m]!.h >= poi.level) return m
  }
  return -1
}

const poiRef = (p: Poi, hitT: number | null): Setup['poi'] => ({ kind: p.kind, timeframe: p.timeframe, level: p.level, t: p.t, hitT, origin: p.origin })

// ---------- M0: old rule (baseline) ----------

function modelM0({ entry, poiAnalyses, cfg }: SetupInput, _pois: readonly Poi[]): Draft[] {
  const c = entry.candles
  const raw = [...poiAnalyses.flatMap(collectPois), ...(cfg.sameTfPoi ? collectPois(entry) : [])]
  const near = cfg.obValidNearPct / 100
  const out: Draft[] = []
  for (const poi of raw) {
    const bull = poi.direction === 'bullish'
    let hitIdx = -1
    for (let m = indexAtOrAfter(c, poi.activeFrom); m < c.length; m++) {
      if (poi.invalidT !== null && c[m]!.t >= poi.invalidT) break
      if (bull ? c[m]!.l <= poi.level : c[m]!.h >= poi.level) {
        hitIdx = m
        break
      }
    }
    if (hitIdx < 0) continue
    const ob = entry.orderBlocksIdx.find(
      (o) =>
        o.direction === poi.direction &&
        o.i >= hitIdx &&
        o.i <= hitIdx + cfg.obValidMaxCandles &&
        (bull ? o.wickEnd <= poi.level * (1 + near) && o.line >= poi.level * (1 - near) : o.wickEnd >= poi.level * (1 - near) && o.line <= poi.level * (1 + near)) &&
        (poi.invalidT === null || o.confirmedT < poi.invalidT)
    )
    if (!ob) continue
    const sl = bull ? ob.wickEnd * (1 - cfg.slBufferPct / 100) : ob.wickEnd * (1 + cfg.slBufferPct / 100)
    out.push({
      model: 'M0',
      dir: poi.direction,
      poi: poiRef(poi, c[hitIdx]!.t),
      child: { kind: 'OB', timeframe: entry.timeframe, t: ob.t, level: ob.line, extreme: ob.wickEnd, hasFvg: ob.hasFvg, origin: null },
      entry: ob.line,
      sl,
      knownIdx: ob.confirmedAt,
      invalidLevel: ob.wickEnd,
      confluence: ob.prevOpposite ? ['prevOpposite'] : [],
      reasons: [`${POI_LABEL[poi.kind]} ${poi.timeframe} kena → OB ${entry.timeframe} (aturan lama)`]
    })
  }
  return out
}

// ---------- refinement: POI hit → LTF CHoCH → small POI (M1 / M2b) ----------

interface Refined {
  child: Setup['child']
  entry: number
  sl: number
  knownIdx: number
  invalidLevel: number
  confluence: Confluence[]
  reasons: string[]
}

/**
 * After the parent POI is hit at `hitIdx`: track the reaction extreme; a CHoCH is a close beyond the
 * last small swing (ltfPivot) that formed before that extreme. The leg must show displacement.
 * Entry at the small POI that leg created: QM (L1 body, mountain 2 = the extreme) > OB with FVG > OB.
 */
export function refine(entry: SmcAnalysisFull, cfg: SmcConfig, dir: Dir, hitIdx: number, parentDeadAt: number | null): Refined | null {
  const c = entry.candles
  const bull = dir === 'bullish'
  const piv = entry.ltfPivots
  const look = hitIdx - 3 * cfg.refineWindow
  const end = Math.min(c.length - 1, hitIdx + cfg.refineWindow)
  const tfMs = TF_MS[entry.timeframe]
  let ext = hitIdx
  let chochIdx = -1
  let ref: Pivot | null = null

  for (let j = hitIdx; j <= end; j++) {
    if (parentDeadAt !== null && c[j]!.t + tfMs > parentDeadAt) return null
    if (bull ? c[j]!.l < c[ext]!.l : c[j]!.h > c[ext]!.h) ext = j
    if (j === ext) continue
    ref = null
    for (let k = piv.length - 1; k >= 0; k--) {
      const p = piv[k]!
      if (p.i < look) break
      if (p.kind === (bull ? 'high' : 'low') && p.i < ext && p.confirmedAt <= j) {
        ref = p
        break
      }
    }
    if (ref && (bull ? c[j]!.c > ref.price : c[j]!.c < ref.price)) {
      chochIdx = j
      break
    }
  }
  if (chochIdx < 0 || !ref) return null
  const j = chochIdx
  const x = c[ext]!
  const extreme = bull ? x.l : x.h

  // displacement: a big body in the leg, or the leg leaves an FVG
  let bigBody = false
  for (let m = ext + 1; m <= j && !bigBody; m++) if (Math.abs(c[m]!.c - c[m]!.o) >= cfg.dispBodyAtr * (entry.atr[m - 1] ?? Infinity)) bigBody = true
  const legFvg = entry.fvgsIdx.some((f) => f.direction === dir && f.i >= ext - 1 && f.i + 2 <= j)
  if (cfg.requireDisplacement && !bigBody && !legFvg) return null

  const confluence: Confluence[] = ['displacement']
  const reasons = [`CHoCH ${entry.timeframe} (close ${bull ? '>' : '<'} swing ${ref.price})`]
  if (legFvg) confluence.push('fvg')
  const swept = sweptSwing(c, piv, ext, bull, cfg.originSwings)
  if (swept) {
    confluence.push('sweep')
    reasons.push(`sweep liquidity ${entry.timeframe} @ ${swept.price}`)
  }

  // child: QM first (L1 = small swing before the CHoCH swing, mountain 2 = the extreme)
  let child: Setup['child'] | null = null
  let knownIdx = j
  let l1: Pivot | null = null
  for (let k = piv.length - 1; k >= 0; k--) {
    const p = piv[k]!
    if (p.i < look) break
    if (p.kind === (bull ? 'low' : 'high') && p.i < ref.i && p.confirmedAt <= j) {
      l1 = p
      break
    }
  }
  if (l1) {
    const k1 = c[l1.i]!
    const deeper = bull ? x.l < l1.price : x.h > l1.price
    const bodyBreak = !cfg.qmRequireBodyBreak || (bull ? bodyLo(x) < k1.l : bodyHi(x) > k1.h)
    const level = bull ? bodyLo(k1) : bodyHi(k1)
    const inside = bull ? level < c[j]!.c && level > extreme : level > c[j]!.c && level < extreme
    if (deeper && bodyBreak && inside)
      child = { kind: 'QM', timeframe: entry.timeframe, t: k1.t, level, extreme, hasFvg: legFvg, origin: null }
  }
  if (!child) {
    let ob: OrderBlockIdx | null = null
    for (const o of entry.orderBlocksIdx) {
      if (o.direction !== dir || o.i < ext - 1 || o.i > j) continue
      if (!ob || (o.hasFvg && !ob.hasFvg) || (o.hasFvg === ob.hasFvg && (bull ? o.wickEnd < ob.wickEnd : o.wickEnd > ob.wickEnd))) ob = o
    }
    if (!ob) return null
    knownIdx = Math.max(j, ob.confirmedAt)
    child = {
      kind: 'OB',
      timeframe: entry.timeframe,
      t: ob.t,
      level: ob.line,
      extreme: bull ? Math.min(extreme, ob.wickEnd) : Math.max(extreme, ob.wickEnd),
      hasFvg: ob.hasFvg || legFvg,
      origin: null
    }
    if (ob.prevOpposite) confluence.push('prevOpposite')
  }
  child.origin = joinOrigin(!!swept, true)
  reasons.push(`entry di ${child.kind} ${entry.timeframe}`)
  const buf = cfg.slBufferPct / 100
  return {
    child,
    entry: child.level,
    sl: bull ? child.extreme * (1 - buf) : child.extreme * (1 + buf),
    knownIdx,
    invalidLevel: child.extreme,
    confluence,
    reasons
  }
}

function modelM1(input: SetupInput, pois: readonly Poi[]): Draft[] {
  const { entry, cfg } = input
  const out: Draft[] = []
  for (const p of parentPois(input, pois)) {
    const hit = firstTouch(entry.candles, p)
    if (hit < 0) continue
    const dead = p.invalidT === null ? null : closeTime(p.invalidT, p.timeframe)
    const r = refine(entry, cfg, p.direction, hit, dead)
    if (!r) continue
    out.push({
      model: 'M1',
      dir: p.direction,
      poi: poiRef(p, entry.candles[hit]!.t),
      ...r,
      reasons: [`${POI_LABEL[p.kind]} ${p.timeframe} (asal: ${p.origin ?? '—'}) kena`, ...r.reasons]
    })
  }
  return out
}

// ---------- M2: liquidity grab (OB behind unswept liquidity) ----------

function modelM2(input: SetupInput, all: readonly SmcAnalysisFull[], pois: readonly Poi[], models: ReadonlySet<EntryModel>): Draft[] {
  const { entry, cfg } = input
  const c = entry.candles
  const tfs = new Set<Timeframe>([entry.timeframe, ...cfg.poiTimeframes])
  const dist = cfg.grabObDistPct / 100
  const out: Draft[] = []
  const originOf = new Map(pois.filter((p) => p.kind === 'OB').map((p) => [`${p.timeframe}|${p.t}|${p.direction}`, p.origin]))

  for (const a of all) {
    if (!tfs.has(a.timeframe)) continue
    for (const ob of a.orderBlocksIdx) {
      const origin = originOf.get(`${a.timeframe}|${ob.t}|${ob.direction}`) ?? null
      if (!origin) continue
      const bull = ob.direction === 'bullish'
      const obActive = closeTime(ob.confirmedT, a.timeframe)
      // nearest unswept swing in front of the OB (formed after it), on any analysed TF
      let best: { price: number; knownT: number; equal: boolean; tf: Timeframe } | null = null
      for (const b of all) {
        if (TF_RANK[b.timeframe] > TF_RANK[a.timeframe]) continue
        for (const p of b.alternating) {
          if (p.kind !== (bull ? 'low' : 'high')) continue
          const k = b.candles[p.i]!
          if (k.t <= ob.t) continue
          const price = p.price
          const inFront = bull ? price > ob.line && price <= ob.line * (1 + dist) : price < ob.line && price >= ob.line * (1 - dist)
          if (!inFront) continue
          if (best && (bull ? price >= best.price : price <= best.price)) continue
          const liq = b.liquidity.find((l) => l.kind === 'swing' && l.t === k.t && l.side === (bull ? 'sell' : 'buy'))
          best = { price, knownT: closeTime(b.candles[p.confirmedAt]!.t, b.timeframe), equal: !!liq?.equal, tf: b.timeframe }
        }
      }
      if (!best) continue
      const T = Math.max(obActive, best.knownT)
      if (ob.invalidT !== null && closeTime(ob.invalidT, a.timeframe) <= T) continue
      if (ob.hitT !== null && closeTime(ob.hitT, a.timeframe) <= T) continue // OB no longer fresh
      const knownIdx = lastClosedBy(c, entry.timeframe, T)
      if (knownIdx < 0) continue
      // liquidity still there when the order goes in
      let swept = false
      for (let m = indexAtOrAfter(c, T - 3 * TF_MS[a.timeframe]); m <= knownIdx && !swept; m++) if (bull ? c[m]!.l < best.price : c[m]!.h > best.price) swept = true
      if (swept) continue

      const confluence: Confluence[] = ['sweep']
      if (best.equal) confluence.push('equalLiq')
      if (ob.hasFvg) confluence.push('fvg')
      if (ob.prevOpposite) confluence.push('prevOpposite')
      const poi: Setup['poi'] = { kind: 'OB', timeframe: a.timeframe, level: ob.line, t: ob.t, hitT: null, origin }
      const liqName = `${bull ? 'SSL' : 'BSL'} ${best.tf} ${best.price}${best.equal ? ' (equal)' : ''}`
      const buf = cfg.slBufferPct / 100

      if (models.has('M2a'))
        out.push({
          model: 'M2a',
          dir: ob.direction,
          poi,
          child: { kind: 'OB', timeframe: a.timeframe, t: ob.t, level: ob.line, extreme: ob.wickEnd, hasFvg: ob.hasFvg, origin },
          entry: ob.line,
          sl: bull ? ob.wickEnd * (1 - buf) : ob.wickEnd * (1 + buf),
          knownIdx,
          invalidLevel: ob.wickEnd,
          confluence,
          reasons: [`OB ${a.timeframe} (asal: ${origin}) di balik ${liqName}`, 'limit di OB, nunggu liquidity disapu']
        })

      if (models.has('M2b')) {
        const p: Poi = { kind: 'OB', timeframe: a.timeframe, direction: ob.direction, level: ob.line, t: ob.t, activeFrom: T, invalidT: ob.invalidT, origin }
        const hit = firstTouch(c, p, closeTime(c[knownIdx]!.t, entry.timeframe))
        if (hit < 0) continue
        const r = refine(entry, cfg, ob.direction, hit, ob.invalidT === null ? null : closeTime(ob.invalidT, a.timeframe))
        if (!r) continue
        out.push({
          model: 'M2b',
          dir: ob.direction,
          poi: { ...poi, hitT: c[hit]!.t },
          ...r,
          confluence: [...new Set<Confluence>([...confluence, ...r.confluence])],
          reasons: [`${liqName} disapu → OB ${a.timeframe} kena`, ...r.reasons]
        })
      }
    }
  }
  return out
}

// ---------- M4: breaker ----------

function modelM4({ entry, cfg }: SetupInput, all: readonly SmcAnalysisFull[]): Draft[] {
  const c = entry.candles
  const tfs = new Set<Timeframe>(cfg.breakerTimeframes ?? [entry.timeframe, ...cfg.poiTimeframes])
  const buf = cfg.slBufferPct / 100
  const out: Draft[] = []
  for (const a of all) {
    if (!tfs.has(a.timeframe)) continue
    const ac = a.candles
    for (const ob of a.orderBlocksIdx) {
      if (ob.invalidT === null) continue
      const b = indexAtOrAfter(ac, ob.invalidT)
      if (b >= ac.length) continue
      // a bearish OB broken upward becomes a bullish breaker (and vice versa)
      const bull = ob.direction === 'bearish'
      const dir: Dir = bull ? 'bullish' : 'bearish'
      // the break must follow a sweep of the swing before the OB
      const e = extremeIdx(ac, ob.i + 1, b, bull)
      let prev: Pivot | null = null
      for (let k = a.pivots.length - 1; k >= 0; k--) {
        const p = a.pivots[k]!
        if (p.kind === (bull ? 'low' : 'high') && p.i < ob.i && p.confirmedAt <= e) {
          prev = p
          break
        }
      }
      if (!prev || (bull ? ac[e]!.l >= prev.price : ac[e]!.h <= prev.price)) continue
      const level = ob.line // body edge facing the retest
      const far = ob.bodyFar
      const T = closeTime(ac[b]!.t, a.timeframe)
      const knownIdx = lastClosedBy(c, entry.timeframe, T)
      if (knownIdx < 0) continue
      const confluence: Confluence[] = ['sweep']
      const lo = Math.min(far, ob.wickEnd)
      const hi = Math.max(far, ob.wickEnd)
      if (a.fvgsIdx.some((f) => f.direction === dir && f.i >= e - 1 && f.i <= b && f.bottom <= hi && f.top >= lo)) confluence.push('unicorn', 'fvg')
      out.push({
        model: 'M4',
        dir,
        poi: { kind: 'OB', timeframe: a.timeframe, level: ob.line, t: ob.t, hitT: null, origin: 'sweep' },
        child: { kind: 'BREAKER', timeframe: a.timeframe, t: ob.t, level, extreme: far, hasFvg: confluence.includes('fvg'), origin: 'sweep' },
        entry: level,
        sl: bull ? far * (1 - buf) : far * (1 + buf),
        knownIdx,
        invalidLevel: far,
        confluence,
        reasons: [`OB ${ob.direction === 'bullish' ? 'bullish' : 'bearish'} ${a.timeframe} dijebol setelah sweep ${prev.price} → breaker`]
      })
    }
  }
  return out
}

// ---------- M5: trend following (Donchian breakout) ----------

/**
 * Not SMC (user asked for other strategies; lab 2y BTC/ETH/SOL with fees: +0,15R/trade, OOS +0,08R).
 * A close of `trendTimeframe` beyond the highest high / lowest low of the previous `trendChannel`
 * candles, on the right side of the EMA → limit at that close (∓ offset × ATR), SL trendAtrMult × ATR
 * behind it. The wide SL keeps fees at ≈ 0,03R. Exit = trailing only (config trendExit).
 */
function modelM5({ entry, cfg }: SetupInput, all: readonly SmcAnalysisFull[]): Draft[] {
  const a = all.find((x) => x.timeframe === cfg.trendTimeframe)
  if (!a) return []
  const c = a.candles
  const n = cfg.trendChannel
  const atr = cfg.atrPeriod === 14 ? a.atr : atrSeries(c, 14)
  const ema = cfg.trendEma > 0 ? emaSeries(c, cfg.trendEma) : null
  const hi = (j: number): number => {
    let m = -Infinity
    for (let k = j - n; k < j; k++) m = Math.max(m, c[k]!.h)
    return m
  }
  const lo = (j: number): number => {
    let m = Infinity
    for (let k = j - n; k < j; k++) m = Math.min(m, c[k]!.l)
    return m
  }
  const out: Draft[] = []
  for (let i = Math.max(n + 1, cfg.trendEma); i < c.length; i++) {
    const x = c[i]!
    const up = x.c > hi(i) && (!ema || x.c > ema[i]!) && (!cfg.trendFreshOnly || c[i - 1]!.c <= hi(i - 1))
    const dn = !cfg.trendLongOnly && x.c < lo(i) && (!ema || x.c < ema[i]!) && (!cfg.trendFreshOnly || c[i - 1]!.c >= lo(i - 1))
    if (!up && !dn) continue
    const knownIdx = lastClosedBy(entry.candles, entry.timeframe, closeTime(x.t, a.timeframe))
    if (knownIdx < 0) continue
    const bull = up
    const level = bull ? x.c - cfg.trendEntryOffsetAtr * atr[i]! : x.c + cfg.trendEntryOffsetAtr * atr[i]!
    const sl = bull ? level - cfg.trendAtrMult * atr[i]! : level + cfg.trendAtrMult * atr[i]!
    const channel = bull ? hi(i) : lo(i)
    out.push({
      model: 'M5',
      dir: bull ? 'bullish' : 'bearish',
      poi: { kind: 'BO', timeframe: a.timeframe, level: channel, t: x.t, hitT: null, origin: null },
      child: { kind: 'BREAKOUT', timeframe: a.timeframe, t: x.t, level, extreme: sl, hasFvg: false, origin: null },
      entry: level,
      sl,
      knownIdx,
      invalidLevel: sl,
      confluence: [],
      reasons: [
        `close ${a.timeframe} ${x.c} tembus ${bull ? 'high' : 'low'} ${n} candle (${channel})${ema ? ` di ${bull ? 'atas' : 'bawah'} EMA${cfg.trendEma}` : ''}`,
        `SL ${cfg.trendAtrMult}×ATR, exit trailing (tanpa BE/TP)`
      ],
      expiry: cfg.trendExpiryCandles
    })
  }
  return out
}

// ---------- M6: radar pump → 1h breakout (not SMC, docs/entry-v2.md §12–13) ----------

/**
 * Radar hit on a closed 1h candle (24h volume ≥ m6VolMult × 30-day median, or funding ≤ m6FundingMax
 * with volume ≥ m6FundingVolMult) → within m6WatchHours, the first 1h close beyond the 24h box of the
 * hit → limit at that close, SL m6AtrMult × ATR(24). No TP: the user takes profit by hand, the bot
 * trails the stop. One trade per hit; the next hit is looked for m6CooldownHours later.
 */
function modelM6({ entry, cfg, flow }: SetupInput, all: readonly SmcAnalysisFull[]): Draft[] {
  const a = all.find((x) => x.timeframe === '1h')
  if (!a || a.candles.length <= RADAR_BARS) return []
  const c = a.candles
  const n = c.length
  const vr = volRatioSeries(c)
  const atr = atrSeries(c, 24)
  const funding = flow?.funding ?? []
  const fundingAt = (closeT: number): number | null => {
    let lo = 0
    let hi = funding.length - 1
    let k = -1
    while (lo <= hi) {
      const m = (lo + hi) >> 1
      if (funding[m]!.t <= closeT) {
        k = m
        lo = m + 1
      } else hi = m - 1
    }
    return k >= 0 && closeT - funding[k]!.t <= 9 * 3_600_000 ? funding[k]!.r : null
  }
  const out: Draft[] = []
  let i = RADAR_BARS - 1
  while (i < n) {
    const v = vr[i]!
    const f = fundingAt(closeTime(c[i]!.t, '1h'))
    const hitVol = v >= cfg.m6VolMult
    const hitFund = f !== null && f <= cfg.m6FundingMax && v >= cfg.m6FundingVolMult
    if (!(hitVol || hitFund)) {
      i++
      continue
    }
    let boxHi = -Infinity
    let boxLo = Infinity
    for (let k = i - 23; k <= i; k++) {
      boxHi = Math.max(boxHi, c[k]!.h)
      boxLo = Math.min(boxLo, c[k]!.l)
    }
    let found = -1
    let bull = true
    for (let k = i + 1; k < n && k <= i + cfg.m6WatchHours; k++) {
      if (c[k]!.c > boxHi) {
        found = k
        break
      }
      if (!cfg.m6LongOnly && c[k]!.c < boxLo) {
        found = k
        bull = false
        break
      }
    }
    const next = (found < 0 ? i + cfg.m6WatchHours + 1 : found) + Math.max(1, cfg.m6CooldownHours)
    if (found >= 0) {
      const x = c[found]!
      const knownIdx = lastClosedBy(entry.candles, entry.timeframe, closeTime(x.t, '1h'))
      const level = x.c
      const sl = bull ? level - cfg.m6AtrMult * atr[found]! : level + cfg.m6AtrMult * atr[found]!
      if (knownIdx >= 0)
        out.push({
          model: 'M6',
          dir: bull ? 'bullish' : 'bearish',
          poi: { kind: 'BO', timeframe: '1h', level: bull ? boxHi : boxLo, t: c[i]!.t, hitT: null, origin: null },
          child: { kind: 'BREAKOUT', timeframe: '1h', t: x.t, level, extreme: sl, hasFvg: false, origin: null },
          entry: level,
          sl,
          knownIdx,
          invalidLevel: sl,
          confluence: [],
          reasons: [
            `radar 1h: volume 24j ${v.toFixed(1)}× median${f !== null ? ` · funding ${(f * 100).toFixed(3)}%` : ''}`,
            `close 1h ${level} tembus ${bull ? 'high' : 'low'} box 24j (${bull ? boxHi : boxLo})`,
            `SL ${cfg.m6AtrMult}×ATR, tanpa TP (manual), SL trailing`
          ],
          expiry: cfg.m6ExpiryCandles
        })
    }
    i = next
  }
  return out
}

/** Hour (UTC) of `t` inside one of the [from, to) killzones. */
export function inKillzone(t: number, zones: readonly (readonly [number, number])[]): boolean {
  const h = new Date(t).getUTCHours()
  return zones.some(([from, to]) => h >= from && h < to)
}

// ---------- score, TP, status ----------

const SCORE: Partial<Record<Confluence, number>> = {
  fvg: 1,
  sweep: 1,
  equalLiq: 1,
  displacement: 1,
  htfParent: 1,
  trendParent: 1,
  btc4h: 1,
  btc1h: 1,
  btcAgainst: -1,
  wyckoff: 1,
  manipulation: 1,
  wyckoffAgainst: -1,
  unicorn: 1,
  prevOpposite: 1
}

const CONF_LABEL: Record<Confluence, string> = {
  fvg: 'ada FVG (info)',
  sweep: 'liquidity disapu',
  equalLiq: 'equal high/low',
  displacement: 'displacement',
  htfParent: 'POI dari TF lebih tinggi',
  trendParent: 'searah trend TF POI',
  btc4h: 'searah trend BTC 4h',
  btc1h: 'searah trend BTC 1h',
  btcAgainst: 'melawan trend BTC',
  wyckoff: 'fase Wyckoff searah',
  manipulation: 'ada manipulation (spring/UTAD) searah',
  wyckoffAgainst: 'fase Wyckoff berlawanan',
  unicorn: 'breaker + FVG (unicorn)',
  prevOpposite: 'candle sebelum OB berlawanan warna',
  killzone: 'muncul di killzone London/NY',
  oiConfirm: 'open interest naik searah harga (24 jam)',
  oiFlush: 'open interest flush (turun 4 jam)',
  fundingContra: 'funding berlawanan dengan crowd',
  oiHold: 'open interest 15 menit tidak turun',
  anomaly: 'koin lagi ramai (volume 24 jam jauh di atas biasa)',
  pdZone: 'long di discount / short di premium (range HTF)',
  bbMomentum: 'momentum Bollinger searah (di sisi band tengah, band melebar)'
}

/** Bollinger bands per candle array (WeakMap cache; key includes the settings). */
const bbCache = new WeakMap<readonly Candle[], { key: string; bb: Bollinger }>()
function bbOf(c: readonly Candle[], cfg: Pick<SmcConfig, 'bbPeriod' | 'bbStdDev'>): Bollinger {
  const key = `${cfg.bbPeriod}|${cfg.bbStdDev}`
  const hit = bbCache.get(c)
  if (hit && hit.key === key && hit.bb.mid.length === c.length) return hit.bb
  const bb = bollinger(c, cfg.bbPeriod, cfg.bbStdDev)
  bbCache.set(c, { key, bb })
  return bb
}

function finalize(input: SetupInput, all: readonly SmcAnalysisFull[], d: Draft, vol1h: { c: readonly Candle[]; vr: number[] } | null): Setup | null {
  const { entry, cfg, symbol } = input
  const c = entry.candles
  const bull = d.dir === 'bullish'
  const risk = Math.abs(d.entry - d.sl)
  if (!(risk > 0) || d.knownIdx >= c.length) return null
  if (bull ? d.sl >= d.entry : d.sl <= d.entry) return null
  const known = closeTime(c[d.knownIdx]!.t, entry.timeframe)
  const conf = new Set<Confluence>(d.confluence)

  if (TF_RANK[d.poi.timeframe] > TF_RANK[entry.timeframe]) conf.add('htfParent')
  const parentA = all.find((a) => a.timeframe === d.poi.timeframe)
  if (parentA && trendKnownAt(parentA, known) === d.dir) conf.add('trendParent')
  if (input.btc) {
    const t4 = input.btc['4h'] ? trendKnownAt(input.btc['4h'], known) : null
    const t1 = input.btc['1h'] ? trendKnownAt(input.btc['1h'], known) : null
    if (t4 === d.dir) conf.add('btc4h')
    if (t1 === d.dir) conf.add('btc1h')
    if (t4 && t1 && t4 !== d.dir && t1 !== d.dir) conf.add('btcAgainst')
  }
  // Wyckoff: highest timeframe that has a phase at that time
  for (const a of [...all].sort((x, y) => TF_RANK[y.timeframe] - TF_RANK[x.timeframe])) {
    if (!a.wyckoff.length) continue
    const st = wyckoffAt(a.wyckoff, known)
    if (!st || st.dir === null) continue
    if (st.dir === d.dir) {
      conf.add('wyckoff')
      if (st.manipulation) conf.add('manipulation')
    } else conf.add('wyckoffAgainst')
    break
  }

  // killzone = when the setup became known (the order goes in then); filter only, no score
  if (inKillzone(known - 1, cfg.killzonesUtc)) conf.add('killzone')
  // futures positioning (filter tags, no score)
  const ago = lastClosedBy(c, entry.timeframe, known - 24 * 3_600_000)
  const pxChg24h = ago >= 0 ? c[d.knownIdx]!.c / c[ago]!.c - 1 : null
  for (const k of flowConfluence(input.flow, known, d.dir, pxChg24h, cfg)) conf.add(k)
  if (vol1h) {
    const k = lastClosedBy(vol1h.c, '1h', known)
    if (k >= 0 && vol1h.vr[k]! >= cfg.anomalyVolMult) conf.add('anomaly')
  }
  // premium / discount of the HTF dealing range at the entry price (no long at the top, no short at the bottom)
  const pdA = all.find((a) => a.timeframe === cfg.pdTimeframe)
  if (pdA) {
    const k = lastClosedBy(pdA.candles, pdA.timeframe, known)
    const pos = rangePosition(pdA.candles, k, cfg.pdLookback, d.entry)
    if (pos !== null && inTradeZone(pos, d.dir, cfg.pdLevel)) conf.add('pdZone')
  }
  const bbA = all.find((a) => a.timeframe === cfg.bbTimeframe)
  if (bbA) {
    const k = lastClosedBy(bbA.candles, bbA.timeframe, known)
    if (k >= 0 && bbMomentumAt(bbA.candles, bbOf(bbA.candles, cfg), k, d.dir, cfg.bbSlopeCandles)) conf.add('bbMomentum')
  }

  // M5 has no target: trailing only (TP far away so status/cancel rules never fire on it)
  const trailOnly = d.model === 'M5' || d.model === 'M6'
  const tpLiquidity = trailOnly ? null : nearestTarget(all, bull, d.entry, known)
  const exit = trailOnly ? { tpMode: 'trail' as const, tpR: 20 } : ((d.model === 'M4' ? breakerExit(cfg) : null) ?? input.exit ?? { tpMode: 'liquidity', tpR: 5 })
  const fixed = bull ? d.entry + exit.tpR * risk : d.entry - exit.tpR * risk
  const tp = exit.tpMode === 'liquidity' && tpLiquidity !== null ? tpLiquidity : fixed
  const rr = Math.abs(tp - d.entry) / risk
  if (d.model === 'M0' && (tpLiquidity === null || Math.abs(tpLiquidity - d.entry) / risk < cfg.minRR)) return null

  let score = 3
  for (const k of conf) score += SCORE[k] ?? 0
  const confluence = [...conf]
  const expiry = d.expiry ?? cfg.setupExpiryCandles
  const { status, statusT, filledT } = followSetup(c, d.knownIdx, bull, d.entry, d.sl, tp, d.invalidLevel, expiry)
  return {
    id: `${symbol}-${d.model}-${d.child.timeframe}-${d.child.t}-${d.dir}`,
    symbol,
    model: d.model,
    direction: d.dir,
    poi: d.poi,
    child: d.child,
    entry: d.entry,
    sl: d.sl,
    tp,
    tpLiquidity,
    rr: Math.round(rr * 100) / 100,
    score,
    confluence,
    reasons: [...d.reasons, ...confluence.filter((k) => !d.confluence.includes(k)).map((k) => CONF_LABEL[k])],
    createdT: c[d.knownIdx]!.t,
    status,
    statusT,
    filledT,
    ...(d.expiry !== undefined ? { expiryCandles: d.expiry } : {})
  }
}

/** Swing liquidity per analysis, prepared once per array (WeakMap cache). */
const targetCache = new WeakMap<readonly unknown[], { price: number; knownT: number; sweptT: number | null; side: 'buy' | 'sell' }[]>()

function targets(a: SmcAnalysisFull) {
  let t = targetCache.get(a.liquidity)
  if (!t) {
    const sw = new Map(a.swings.map((s) => [s.t, s]))
    t = []
    for (const l of a.liquidity) {
      if (l.kind !== 'swing') continue
      const s = sw.get(l.t)
      if (!s) continue
      t.push({ price: l.top, knownT: closeTime(s.confirmedT, a.timeframe), sweptT: l.sweptT, side: l.side })
    }
    targetCache.set(a.liquidity, t)
  }
  return t
}

/** Nearest unswept opposite swing (from any analysed TF) known at `knownAt`. */
function nearestTarget(analyses: readonly SmcAnalysisFull[], bull: boolean, entry: number, knownAt: number): number | null {
  let best: number | null = null
  for (const a of analyses) {
    for (const l of targets(a)) {
      if (l.side !== (bull ? 'buy' : 'sell') || l.knownT > knownAt) continue
      if (l.sweptT !== null && l.sweptT < knownAt) continue
      if (bull ? l.price > entry && (best === null || l.price < best) : l.price < entry && (best === null || l.price > best)) best = l.price
    }
  }
  return best
}

/**
 * Trend of `a` as known at time `t`. A change is only known once its breaking candle has closed
 * (`ch.t` is that candle's open time), so a 4h break can't score a 15m setup earlier in the same 4h.
 */
export function trendKnownAt(a: Pick<SmcAnalysisFull, 'timeframe' | 'trendChanges'>, t: number): Dir | null {
  let trend: Dir | null = null
  for (const ch of a.trendChanges) {
    if (closeTime(ch.t, a.timeframe) > t) break
    trend = ch.trend
  }
  return trend
}

/**
 * Walk entry-TF candles after the setup is known. Same-candle SL/TP counts as a loss, and a
 * pending limit is cancelled ('missed') once price reaches the TP first, including a candle that
 * touches both entry and TP (order inside the candle is unknown → conservative, no trade).
 */
export function followSetup(
  c: readonly Candle[],
  from: number,
  bull: boolean,
  entry: number,
  sl: number,
  tp: number,
  invalidLevel: number,
  expiry: number
): { status: SetupStatus; statusT: number | null; filledT: number | null } {
  let triggered = false
  let triggeredT: number | null = null
  for (let m = from + 1; m < c.length; m++) {
    const x = c[m]!
    if (!triggered) {
      if (m - from > expiry) return { status: 'expired', statusT: x.t, filledT: null }
      if (bull ? x.h >= tp : x.l <= tp) return { status: 'missed', statusT: x.t, filledT: null }
      if (bull ? x.l <= entry : x.h >= entry) {
        triggered = true
        triggeredT = x.t
      } else if (bull ? x.c < invalidLevel : x.c > invalidLevel) return { status: 'invalid', statusT: x.t, filledT: null }
      else continue
    }
    const hitSl = bull ? x.l <= sl : x.h >= sl
    const hitTp = bull ? x.h >= tp : x.l <= tp
    if (hitSl) return { status: 'loss', statusT: x.t, filledT: triggeredT }
    if (hitTp) return { status: 'win', statusT: x.t, filledT: triggeredT }
  }
  return triggered ? { status: 'triggered', statusT: triggeredT, filledT: triggeredT } : { status: 'pending', statusT: null, filledT: null }
}

