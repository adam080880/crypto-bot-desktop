import type { ReactionRow } from '@shared/backtest'
import type { Candle } from '@shared/candles'
import { indexAtOrAfter, type Poi } from '../strategy/setups'

export const RACE_PCTS = [0.5, 1, 2] as const

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export interface PoiTouch {
  poi: Poi
  touchT: number
  /** 'win' | 'loss' | 'timeout' per RACE_PCTS entry. */
  race: ('win' | 'loss' | 'timeout')[]
  invalidated: boolean
  mfePct: number
  maePct: number
}

/**
 * How price reacts at a POI, independent of the OB valid entry. From the first touch (on the
 * entry TF, while the POI is active) price races from the POI level: +X% in the POI direction vs
 * −X% through it. Within one candle the adverse side counts first (conservative), and the touch
 * candle can only lose (its favourable move may have come before the touch).
 */
export function poiTouch(poi: Poi, c: readonly Candle[], windowMs: number): PoiTouch | null {
  const bull = poi.direction === 'bullish'
  let i = indexAtOrAfter(c, poi.activeFrom)
  for (; i < c.length; i++) {
    if (poi.invalidT !== null && c[i]!.t >= poi.invalidT) return null
    if (bull ? c[i]!.l <= poi.level : c[i]!.h >= poi.level) break
  }
  if (i >= c.length) return null
  const touchT = c[i]!.t
  const end = touchT + windowMs
  const L = poi.level
  const adverse = (x: Candle): number => (bull ? (L - x.l) / L : (x.h - L) / L) * 100
  const favourable = (x: Candle): number => (bull ? (x.h - L) / L : (L - x.l) / L) * 100
  const race: PoiTouch['race'] = RACE_PCTS.map(() => 'timeout')
  let mae = Math.max(0, adverse(c[i]!))
  let mfe = 0
  RACE_PCTS.forEach((p, k) => {
    if (mae >= p) race[k] = 'loss'
  })
  for (let m = i + 1; m < c.length && c[m]!.t < end; m++) {
    const a = adverse(c[m]!)
    const f = favourable(c[m]!)
    RACE_PCTS.forEach((p, k) => {
      if (race[k] !== 'timeout') return
      if (a >= p) race[k] = 'loss'
      else if (f >= p) race[k] = 'win'
    })
    mae = Math.max(mae, a)
    mfe = Math.max(mfe, f)
  }
  const invalidated = poi.invalidT !== null && poi.invalidT < end
  return { poi, touchT, race, invalidated, mfePct: mfe, maePct: mae }
}

export function reactionRows(pois: readonly Poi[], touches: readonly PoiTouch[]): ReactionRow[] {
  const key = (p: Poi): string => `${p.kind}|${p.timeframe}`
  const rows = new Map<string, ReactionRow & { mfe: number[]; mae: number[] }>()
  const row = (p: Poi) => {
    let r = rows.get(key(p))
    if (!r) {
      r = {
        kind: p.kind,
        timeframe: p.timeframe,
        pois: 0,
        touches: 0,
        race: RACE_PCTS.map((pct) => ({ pct, win: 0, loss: 0, timeout: 0 })),
        invalidated: 0,
        medianMfePct: null,
        medianMaePct: null,
        mfe: [],
        mae: []
      }
      rows.set(key(p), r)
    }
    return r
  }
  for (const p of pois) row(p).pois++
  for (const t of touches) {
    const r = row(t.poi)
    r.touches++
    t.race.forEach((o, k) => r.race[k]![o]++)
    if (t.invalidated) r.invalidated++
    r.mfe.push(t.mfePct)
    r.mae.push(t.maePct)
  }
  const TF = { '1m': 0, '5m': 1, '15m': 2, '1h': 3, '4h': 4, '1d': 5, '1w': 6 }
  return [...rows.values()]
    .map(({ mfe, mae, ...r }) => ({ ...r, medianMfePct: median(mfe), medianMaePct: median(mae) }))
    .sort((a, b) => TF[b.timeframe] - TF[a.timeframe] || b.touches - a.touches)
}
