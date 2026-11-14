import type { Candle } from '@shared/candles'
import type { SmcConfig } from '@shared/config'
import type { Dir, PoiKind, Setup, SetupStatus } from '@shared/smc'
import { TF_MS, type Timeframe } from '@shared/timeframes'
import type { SmcAnalysisFull } from './analyze'

/** A point of interest from any timeframe, normalised for §8. */
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
}

const closeTime = (t: number, tf: Timeframe): number => t + TF_MS[tf]

/** Collect active-able POIs (OB, RBS/SBR, QM, OCL/OCL break) from one analysis. */
export function collectPois(a: SmcAnalysisFull): Poi[] {
  const tf = a.timeframe
  const pois: Poi[] = []
  for (const ob of a.orderBlocks)
    pois.push({ kind: 'OB', timeframe: tf, direction: ob.direction, level: ob.line, t: ob.t, activeFrom: closeTime(ob.confirmedT, tf), invalidT: ob.invalidT })
  for (const f of a.srFlips)
    pois.push({ kind: f.kind, timeframe: tf, direction: f.direction, level: f.level, t: f.sourceT, activeFrom: closeTime(f.breakT, tf), invalidT: f.invalidT })
  for (const q of a.qms)
    pois.push({ kind: 'QM', timeframe: tf, direction: q.direction, level: q.level, t: q.points.h1, activeFrom: closeTime(q.activeT, tf), invalidT: q.invalidT })
  for (const o of a.ocls) {
    if (o.kind === 'OCL')
      pois.push({ kind: 'OCL', timeframe: tf, direction: o.direction, level: o.level, t: o.t, activeFrom: closeTime(o.t, tf) + TF_MS[tf], invalidT: o.invalidT })
    else if (o.breakT !== null)
      pois.push({ kind: 'OCL_BREAK', timeframe: tf, direction: o.direction, level: o.level, t: o.t, activeFrom: closeTime(o.breakT, tf), invalidT: o.invalidT })
  }
  return pois
}

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

const TF_RANK: Record<Timeframe, number> = { '1m': 0, '5m': 1, '15m': 2, '1h': 3, '4h': 4, '1d': 5, '1w': 6 }

export interface SetupInput {
  symbol: string
  entry: SmcAnalysisFull
  /** Higher-timeframe analyses providing POIs (4h, 1h by default). */
  poiAnalyses: readonly SmcAnalysisFull[]
  cfg: SmcConfig
}

/**
 * §8 "POI hit POI → OB valid":
 *  1. a POI is active (known, not yet invalidated on its own TF);
 *  2. price hits it on the entry TF;
 *  3. within `obValidMaxCandles` an entry-TF OB of the same direction forms whose wick reaches the
 *     POI (± obValidNearPct) while its body stays on the right side → OB valid;
 *  4. limit at the OB valid line, SL beyond its wick (+buffer), TP at the nearest unswept opposite
 *     swing; skipped when RR < minRR.
 * Status is then followed on the entry TF: pending → triggered → win/loss, or invalid/expired.
 */
export function detectSetups({ symbol, entry, poiAnalyses, cfg }: SetupInput): Setup[] {
  const c = entry.candles
  if (!c.length) return []
  const pois = [...poiAnalyses.flatMap(collectPois), ...(cfg.sameTfPoi ? collectPois(entry) : [])]
  const near = cfg.obValidNearPct / 100
  const best = new Map<string, Setup>()

  for (const poi of pois) {
    const bull = poi.direction === 'bullish'
    // 1–2: first touch on the entry TF while the POI is valid
    let hitIdx = -1
    for (let m = indexAtOrAfter(c, poi.activeFrom); m < c.length; m++) {
      if (poi.invalidT !== null && c[m]!.t >= poi.invalidT) break
      if (bull ? c[m]!.l <= poi.level : c[m]!.h >= poi.level) {
        hitIdx = m
        break
      }
    }
    if (hitIdx < 0) continue

    // 3: OB valid
    const ob = entry.orderBlocksIdx.find(
      (o) =>
        o.direction === poi.direction &&
        o.i >= hitIdx &&
        o.i <= hitIdx + cfg.obValidMaxCandles &&
        (bull ? o.wickEnd <= poi.level * (1 + near) && o.line >= poi.level * (1 - near) : o.wickEnd >= poi.level * (1 - near) && o.line <= poi.level * (1 + near)) &&
        (poi.invalidT === null || o.confirmedT < poi.invalidT)
    )
    if (!ob) continue

    // 4: levels
    const entryPx = ob.line
    const sl = bull ? ob.wickEnd * (1 - cfg.slBufferPct / 100) : ob.wickEnd * (1 + cfg.slBufferPct / 100)
    const risk = Math.abs(entryPx - sl)
    if (risk <= 0) continue
    const createdT = ob.confirmedT
    const known = closeTime(createdT, entry.timeframe)
    const tp = nearestTarget([entry, ...poiAnalyses], bull, entryPx, known)
    if (tp === null) continue
    const rr = Math.abs(tp - entryPx) / risk
    if (rr < cfg.minRR) continue

    // score (§9 + Q5b)
    const reasons: string[] = [`${poi.kind} ${poi.timeframe} kena → OB valid ${entry.timeframe}`]
    let score = 3
    if (ob.hasFvg) {
      score += 2
      reasons.push('OB valid punya FVG')
    } else {
      score -= 2
      reasons.push('OB valid tanpa FVG (low probability)')
    }
    if (TF_RANK[poi.timeframe] > TF_RANK[entry.timeframe]) {
      score += 1
      reasons.push(`POI dari TF lebih tinggi (${poi.timeframe})`)
    }
    const poiA = poiAnalyses.find((a) => a.timeframe === poi.timeframe) ?? entry
    const trend = trendKnownAt(poiA, known)
    if (trend === poi.direction) {
      score += 1
      reasons.push(`searah trend ${poi.timeframe}`)
    }
    if (ob.prevOpposite) {
      score += 1
      reasons.push('candle sebelum OB berlawanan warna')
    }

    const { status, statusT, filledT } = followSetup(c, ob.confirmedAt, bull, entryPx, sl, tp, ob.wickEnd, cfg.setupExpiryCandles)
    const setup: Setup = {
      id: `${symbol}-${entry.timeframe}-${ob.t}-${poi.direction}`,
      symbol,
      direction: poi.direction,
      poi: { kind: poi.kind, timeframe: poi.timeframe, level: poi.level, t: poi.t, hitT: c[hitIdx]!.t },
      obValid: { timeframe: entry.timeframe, t: ob.t, line: ob.line, wickEnd: ob.wickEnd, hasFvg: ob.hasFvg },
      entry: entryPx,
      sl,
      tp,
      rr: Math.round(rr * 100) / 100,
      score,
      reasons,
      createdT,
      status,
      statusT,
      filledT
    }
    const prev = best.get(setup.id)
    if (!prev || setup.score > prev.score) best.set(setup.id, setup)
  }
  return [...best.values()].sort((a, b) => a.createdT - b.createdT)
}

/** Nearest unswept opposite swing (from any analysed TF) known at `knownAt`. */
function nearestTarget(analyses: readonly SmcAnalysisFull[], bull: boolean, entry: number, knownAt: number): number | null {
  let best: number | null = null
  for (const a of analyses) {
    for (const l of a.liquidity) {
      if (l.kind !== 'swing' || l.side !== (bull ? 'buy' : 'sell')) continue
      const sw = a.swings.find((s) => s.t === l.t)
      if (!sw || closeTime(sw.confirmedT, a.timeframe) > knownAt) continue
      if (l.sweptT !== null && l.sweptT < knownAt) continue
      if (bull ? l.top > entry && (best === null || l.top < best) : l.bottom < entry && (best === null || l.bottom > best))
        best = bull ? l.top : l.bottom
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
 * Walk entry-TF candles after the OB valid is known. Same-candle SL/TP counts as a loss, and a
 * pending limit is cancelled ('missed') once price reaches the TP first, including a candle that
 * touches both entry and TP (order inside the candle is unknown → conservative, no trade).
 */
function followSetup(
  c: readonly Candle[],
  from: number,
  bull: boolean,
  entry: number,
  sl: number,
  tp: number,
  wickEnd: number,
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
      } else if (bull ? x.c < wickEnd : x.c > wickEnd) return { status: 'invalid', statusT: x.t, filledT: null }
      else continue
    }
    const hitSl = bull ? x.l <= sl : x.h >= sl
    const hitTp = bull ? x.h >= tp : x.l <= tp
    if (hitSl) return { status: 'loss', statusT: x.t, filledT: triggeredT }
    if (hitTp) return { status: 'win', statusT: x.t, filledT: triggeredT }
  }
  return triggered ? { status: 'triggered', statusT: triggeredT, filledT: triggeredT } : { status: 'pending', statusT: null, filledT: null }
}
