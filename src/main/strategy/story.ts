import type { Candle } from '@shared/candles'
import type { Dir } from '@shared/smc'
import { POI_LABEL } from '@shared/smc'
import { EMPTY_FEATURES, type LiqPool, type PoiStory, type StoryFact, type StoryFeatures } from '@shared/story'
import { TF_MS, type Timeframe } from '@shared/timeframes'
import type { SmcAnalysisFull } from './analyze'
import type { InducementIndex } from './inducement'
import { rangePosition } from './premium'
import { indexAtOrAfter, trendKnownAt, type Poi } from './setups'

/**
 * POI anatomy (layer 1) + liquidity draw A → B (layer 2), docs/smc-rules.md §12. Pure and causal: only what is known
 * at `at` (closed candles, pools known and not yet swept by then).
 */

const H = 3_600_000
const closeT = (t: number, tf: Timeframe): number => t + TF_MS[tf]
const lastClosedBy = (c: readonly Candle[], tf: Timeframe, t: number): number => indexAtOrAfter(c, t - TF_MS[tf] + 1) - 1
/** 15m = 1, 1h = 3, 4h = 5, 1d ≈ 7.6, 1w ≈ 10.4. */
export const tfWeight = (tf: Timeframe): number => Math.max(1, Math.log2(TF_MS[tf] / TF_MS['15m']) + 1)
const fmtR = (r: number): string => `${r.toFixed(1).replace('.', ',')}R`
const SIDE_LABEL = { buy: 'BSL', sell: 'SSL' } as const
const KIND_LABEL: Record<LiqPool['kind'], string> = { swing: 'swing', equal: 'equal', pdh: 'high kemarin', pdl: 'low kemarin', pwh: 'high minggu lalu', pwl: 'low minggu lalu' }
export const poolLabel = (p: LiqPool): string =>
  p.kind === 'swing' || p.kind === 'equal' ? `${SIDE_LABEL[p.side]} ${p.tf}${p.kind === 'equal' ? ' (equal)' : ''}` : `${SIDE_LABEL[p.side]} ${KIND_LABEL[p.kind]}`
const ageText = (h: number): string => (h >= 48 ? `${Math.round(h / 24)} hari` : `${Math.max(1, Math.round(h))} jam`)

// ---------------------------------------------------------------------------------------------
// Layer 2: liquidity map
// ---------------------------------------------------------------------------------------------

/**
 * Unswept liquidity known at `at`: swing pools of every analysis (equal ×2), plus the previous day / week high and low
 * (from the 1d candles, swept = traded through since that day / week closed, checked on the smallest analysis).
 * Weight = timeframe weight × (equal ? 2 : 1) × (1 + min(age, 14 days) / 14); pools within 0.15 % merge (weights add).
 */
export function liquidityPools(all: readonly SmcAnalysisFull[], at: number): LiqPool[] {
  const raw: LiqPool[] = []
  for (const a of all) {
    const tf = a.timeframe
    const sw = new Map(a.swings.map((s) => [s.t, s]))
    for (const l of a.liquidity) {
      if (l.kind !== 'swing') continue
      const s = sw.get(l.t)
      if (!s) continue
      const knownT = closeT(s.confirmedT, tf)
      if (knownT > at || (l.sweptT !== null && closeT(l.sweptT, tf) <= at)) continue
      const ageH = (at - knownT) / H
      raw.push({ price: l.top, side: l.side, tf, kind: l.equal ? 'equal' : 'swing', weight: tfWeight(tf) * (l.equal ? 2 : 1) * (1 + Math.min(ageH, 336) / 336), ageH })
    }
  }
  const d1 = all.find((a) => a.timeframe === '1d')
  const fine = [...all].sort((x, y) => TF_MS[x.timeframe] - TF_MS[y.timeframe])[0]
  if (d1 && fine) {
    const k = lastClosedBy(d1.candles, '1d', at)
    // high / low traded since `from` (closed candles of the smallest analysis up to `at`)
    const since = (from: number): { h: number; l: number } => {
      let h = -Infinity
      let l = Infinity
      const c = fine.candles
      for (let m = indexAtOrAfter(c, from); m < c.length && closeT(c[m]!.t, fine.timeframe) <= at; m++) {
        h = Math.max(h, c[m]!.h)
        l = Math.min(l, c[m]!.l)
      }
      return { h, l }
    }
    if (k >= 0) {
      const day = d1.candles[k]!
      const s = since(closeT(day.t, '1d'))
      const ageH = (at - closeT(day.t, '1d')) / H
      if (s.h < day.h) raw.push({ price: day.h, side: 'buy', tf: '1d', kind: 'pdh', weight: tfWeight('1d'), ageH })
      if (s.l > day.l) raw.push({ price: day.l, side: 'sell', tf: '1d', kind: 'pdl', weight: tfWeight('1d'), ageH })
      // previous week (Monday 00:00 UTC) from the closed daily candles
      const wk = 7 * 24 * H
      const weekStart = Math.floor((at - 4 * 24 * H) / wk) * wk + 4 * 24 * H // epoch was a Thursday
      let wh = -Infinity
      let wl = Infinity
      for (let m = k; m >= 0 && d1.candles[m]!.t >= weekStart - wk; m--) {
        const x = d1.candles[m]!
        if (x.t >= weekStart) continue
        wh = Math.max(wh, x.h)
        wl = Math.min(wl, x.l)
      }
      if (Number.isFinite(wh)) {
        const sw = since(weekStart)
        const wAge = (at - weekStart) / H
        if (sw.h < wh) raw.push({ price: wh, side: 'buy', tf: '1w', kind: 'pwh', weight: tfWeight('1w'), ageH: wAge })
        if (sw.l > wl) raw.push({ price: wl, side: 'sell', tf: '1w', kind: 'pwl', weight: tfWeight('1w'), ageH: wAge })
      }
    }
  }
  // merge neighbours: the pool of the larger timeframe keeps its label, weights add up
  raw.sort((x, y) => x.price - y.price)
  const out: LiqPool[] = []
  for (const p of raw) {
    const prev = out.at(-1)
    if (prev && prev.side === p.side && Math.abs(p.price - prev.price) / prev.price <= 0.0015) {
      const big = TF_MS[p.tf] > TF_MS[prev.tf] || (p.tf === prev.tf && p.kind === 'equal') ? p : prev
      out[out.length - 1] = { ...big, weight: prev.weight + p.weight, ageH: Math.max(prev.ageH, p.ageH) }
    } else out.push({ ...p })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Shared pieces (also used as setup tags: dispStrong, liqTarget)
// ---------------------------------------------------------------------------------------------

/** Biggest body ÷ ATR in the leg from the POI's origin candle to the candle that made it known (null = unknown). */
export function legDisplacement(poi: Poi, a: SmcAnalysisFull): { disp: number; e: number; k: number } | null {
  const c = a.candles
  const e = poi.originT !== undefined ? indexAtOrAfter(c, poi.originT) : -1
  const k = Math.min(c.length - 1, indexAtOrAfter(c, poi.activeFrom - TF_MS[a.timeframe]))
  if (e < 0 || k < e) return null
  let best = 0
  for (let m = e; m <= k; m++) {
    const atr = a.atr[m - 1] ?? a.atr[m]
    if (atr && atr > 0) best = Math.max(best, Math.abs(c[m]!.c - c[m]!.o) / atr)
  }
  return { disp: best, e, k }
}

/** The POI's own stop (beyond its extreme + 0.1 ATR, at least 0.3 %) and B: the pool in the trade direction with the biggest
 *  weight ÷ distance in R, at least 1R away. */
export function drawTarget(poi: Poi, a: SmcAnalysisFull, pools: readonly LiqPool[], at: number): { sl: number; risk: number; target: (LiqPool & { distR: number }) | null } {
  const bull = poi.direction === 'bullish'
  const atrK = a.atr[lastClosedBy(a.candles, a.timeframe, at)] ?? 0
  const ext = poi.extreme ?? (bull ? poi.level * 0.995 : poi.level * 1.005)
  const sl = bull ? Math.min(ext - 0.1 * atrK, poi.level * 0.997) : Math.max(ext + 0.1 * atrK, poi.level * 1.003)
  const risk = Math.abs(poi.level - sl)
  let target: (LiqPool & { distR: number }) | null = null
  if (risk > 0) {
    let bestDraw = 0
    for (const p of pools) {
      if (p.side !== (bull ? 'buy' : 'sell') || (bull ? p.price <= poi.level : p.price >= poi.level)) continue
      const distR = Math.abs(p.price - poi.level) / risk
      const draw = p.weight / Math.max(distR, 0.5)
      if (distR >= 1 && draw > bestDraw) {
        bestDraw = draw
        target = { ...p, distR }
      }
    }
  }
  return { sl, risk, target }
}

/** Nearest unswept pool on the stop side within 1R beyond the POI's own stop (null = clean). */
export function poolBehindSl(poi: Poi, pools: readonly LiqPool[], sl: number, risk: number): (LiqPool & { distR: number }) | null {
  const bull = poi.direction === 'bullish'
  let best: (LiqPool & { distR: number }) | null = null
  if (!(risk > 0)) return null
  for (const p of pools) {
    if (p.side !== (bull ? 'sell' : 'buy') || (bull ? p.price >= sl : p.price <= sl)) continue
    const distR = Math.abs(p.price - sl) / risk
    if (distR <= 1 && (!best || distR < best.distR)) best = { ...p, distR }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Layer 1: anatomy
// ---------------------------------------------------------------------------------------------

export interface StoryCtx {
  at: number
  price: number
  /** Every POI of the same analyses (for the HTF tap and the blockers). */
  pois: readonly Poi[]
  pools: readonly LiqPool[]
  /** Every POI incl. ones invalid now (the parent tap is checked at the origin candle). */
  allPois?: readonly Poi[]
  /** smc.originNearPct (HTF tap distance, %). */
  originNearPct?: number
  /** BTC 4h trend source (omit for BTC itself / none). */
  btc4h?: Pick<SmcAnalysisFull, 'timeframe' | 'trendChanges'>
  idx?: InducementIndex | null
  pdTimeframe?: Timeframe
  pdLookback?: number
}

const poiId = (p: Poi): string => `${p.kind}-${p.timeframe}-${p.t}-${p.direction}`

/** Liquidity taken by the origin candle: pools of any TF that candle swept (they existed before it). */
function takenBy(all: readonly SmcAnalysisFull[], x: Candle, tf: Timeframe, bull: boolean): LiqPool[] {
  const out: LiqPool[] = []
  const xClose = closeT(x.t, tf)
  for (const a of all) {
    const sw = new Map(a.swings.map((s) => [s.t, s]))
    const big = TF_MS[a.timeframe] > TF_MS[tf]
    for (const l of a.liquidity) {
      if (l.kind !== 'swing' || l.side !== (bull ? 'sell' : 'buy') || l.sweptT === null) continue
      const s = sw.get(l.t)
      if (!s || closeT(s.confirmedT, a.timeframe) > xClose) continue
      // swept inside the origin candle (smaller / same TF) or by the HTF candle that contains it
      const inside = big ? l.sweptT <= x.t && x.t < closeT(l.sweptT, a.timeframe) : l.sweptT >= x.t && l.sweptT < xClose
      if (!inside || (bull ? x.l >= l.top : x.h <= l.top)) continue
      const ageH = (x.t - closeT(s.confirmedT, a.timeframe)) / H
      out.push({ price: l.top, side: l.side, tf: a.timeframe, kind: l.equal ? 'equal' : 'swing', weight: tfWeight(a.timeframe) * (l.equal ? 2 : 1) * (1 + Math.min(ageH, 336) / 336), ageH })
    }
  }
  return out.sort((p, q) => q.weight - p.weight)
}

/** Why `poi` formed, how strong it left, how fresh it is, its context and its draw (A → B). */
export function poiStory(poi: Poi, all: readonly SmcAnalysisFull[], ctx: StoryCtx): PoiStory | null {
  const a = all.find((x) => x.timeframe === poi.timeframe)
  if (!a) return null
  const c = a.candles
  const tf = poi.timeframe
  const bull = poi.direction === 'bullish'
  const dir: Dir = poi.direction
  const facts: StoryFact[] = []
  const add = (kind: StoryFact['kind'], sign: StoryFact['sign'], text: string): void => void facts.push({ kind, sign, text })
  // numeric features for the probability layer (layer 3); same facts as the text, as numbers
  const fx: StoryFeatures = { ...EMPTY_FEATURES }

  // ---- cause: what created it (A) ----
  const e = poi.originT !== undefined ? indexAtOrAfter(c, poi.originT) : -1
  const x = e >= 0 ? c[e] : undefined
  const taken = x ? takenBy(all, x, tf, bull) : []
  // a sweep counts as a cause when the pool is of the POI's own timeframe or bigger; smaller pools are only noted
  const real = taken.filter((p) => TF_MS[p.tf] >= TF_MS[tf])
  const small = taken.filter((p) => TF_MS[p.tf] < TF_MS[tf])
  let causes = 0
  fx.sweepW = real.length ? real[0]!.weight : 0
  fx.sweepTfRatio = real.length ? Math.log2(TF_MS[real[0]!.tf] / TF_MS[tf]) + 1 : 0
  fx.sweepEqual = real.some((p) => p.kind === 'equal') ? 1 : 0
  fx.smallSweep = small.length ? 1 : 0
  if (real.length) {
    add('cause', 1, `Lahir setelah ngambil ${real.slice(0, 2).map((p) => `${poolLabel(p)} (umur ${ageText(p.ageH)})`).join(' + ')}`)
    causes++
  } else if (poi.kind === 'QM') {
    add('cause', 1, 'QM: gunung 2 nyapu liquidity gunung 1')
    causes++
  }
  if (small.length) add('cause', 0, `Sempat nyapu liquidity kecil: ${small.slice(0, 2).map(poolLabel).join(' + ')}`)
  if (x) {
    const known = closeT(x.t, tf)
    const near = (ctx.originNearPct ?? 0.3) / 100
    const parent = (ctx.allPois ?? ctx.pois).find(
      (p) =>
        TF_MS[p.timeframe] > TF_MS[tf] &&
        p.direction === dir &&
        p.activeFrom <= known &&
        (p.invalidT === null || closeT(p.invalidT, p.timeframe) > x.t) &&
        (bull ? x.l <= p.level * (1 + near) && x.c >= p.level * (1 - near) : x.h >= p.level * (1 - near) && x.c <= p.level * (1 + near))
    )
    if (parent) {
      add('cause', 1, `Reaksi dari ${POI_LABEL[parent.kind]} ${parent.timeframe} (POI induk)`)
      causes++
      fx.htfTap = 1
    }
  }
  fx.noCause = causes ? 0 : 1
  if (!causes) add('cause', -1, `Nggak ada penyebab jelas (tanpa sweep liquidity ≥ ${tf} / tap POI HTF), POI lemah`)

  // ---- push: the leg that made it known ----
  const leg = legDisplacement(poi, a)
  if (leg) {
    const { disp: best, k } = leg
    fx.disp = best
    const t = `${best.toFixed(1).replace('.', ',')}× ATR`
    if (best >= 1.5) add('push', 1, `Displacement kuat (body ${t})`)
    else if (best < 0.8) add('push', -1, `Dorongan lemah (body maks ${t})`)
    else add('push', 0, `Dorongan sedang (body ${t})`)
    const fvgs = a.fvgsIdx.filter((f) => f.direction === dir && f.i >= e - 1 && f.i <= k)
    if (fvgs.length) {
      const open = fvgs.filter((f) => f.filledT === null || closeT(f.filledT, tf) > ctx.at)
      fx.fvg = 1
      fx.fvgOpen = open.length ? 1 : 0
      add('push', open.length ? 1 : 0, open.length ? `Ninggalin FVG ${tf} yang masih terbuka (imbalance belum dibayar)` : `Ninggalin FVG ${tf}, sudah ketutup`)
    }
    const bos = a.breaks.find((b) => b.direction === dir && b.t >= x!.t && b.t <= c[k]!.t + 3 * TF_MS[tf])
    if (bos) {
      add('push', 1, `Bikin perubahan struktur ${tf} (BOS)`)
      fx.bos = 1
    }
  }

  // ---- fuel: freshness + inducement ----
  let touches = 0
  let inside = false
  for (let m = indexAtOrAfter(c, poi.activeFrom); m < c.length && closeT(c[m]!.t, tf) <= ctx.at; m++) {
    const hit = bull ? c[m]!.l <= poi.level : c[m]!.h >= poi.level
    if (hit && !inside) touches++
    inside = hit
  }
  fx.touches = touches
  if (touches === 0) add('fuel', 1, 'Masih fresh (belum pernah disentuh)')
  else add('fuel', -1, `Sudah dimitigasi ${touches}× (order di zona ini sebagian sudah terpakai)`)
  if (ctx.idx) {
    const ind = ctx.idx.at(poi, ctx.at)
    fx.bait = ind.baitT !== null ? 1 : 0
    fx.idm = ind.idm ? 1 : 0
    fx.extremePoi = ind.extreme ? 1 : 0
    if (ind.baitT !== null) add('fuel', 1, 'Umpan di depannya (POI tanpa penyebab) sudah diambil')
    if (ind.idm) add('fuel', 1, 'IDM (pullback internal pertama) sudah disapu')
    if (ind.extreme) add('fuel', 1, 'Extreme POI: nggak ada POI searah di belakangnya')
  }

  // ---- context ----
  const own = trendKnownAt(a, ctx.at)
  fx.trendOwn = own ? (own === dir ? 1 : -1) : 0
  if (own) add('context', own === dir ? 1 : -1, `${own === dir ? 'Searah' : 'Melawan'} trend ${tf}`)
  const d1 = all.find((x2) => x2.timeframe === '1d')
  if (d1 && tf !== '1d') {
    const t1 = trendKnownAt(d1, ctx.at)
    fx.trend1d = t1 ? (t1 === dir ? 1 : -1) : 0
    if (t1) add('context', t1 === dir ? 1 : -1, `${t1 === dir ? 'Searah' : 'Melawan'} trend 1d`)
  }
  if (ctx.btc4h) {
    const tb = trendKnownAt(ctx.btc4h, ctx.at)
    fx.btc4h = tb ? (tb === dir ? 1 : -1) : 0
    if (tb) add('context', tb === dir ? 1 : -1, `${tb === dir ? 'Searah' : 'Melawan'} trend BTC 4h`)
  }
  const pdA = all.find((x2) => x2.timeframe === (ctx.pdTimeframe ?? '4h'))
  if (pdA) {
    const pos = rangePosition(pdA.candles, lastClosedBy(pdA.candles, pdA.timeframe, ctx.at), ctx.pdLookback ?? 60, poi.level)
    if (pos !== null) {
      // 0 = deepest in the favourable half (discount for longs / premium for shorts), 1 = worst
      fx.pdBad = Math.min(1, Math.max(0, bull ? pos : 1 - pos))
      const pct = Math.round(Math.min(1, Math.max(0, pos)) * 100)
      const good = bull ? pos <= 0.5 : pos >= 0.5
      add('context', good ? 1 : -1, `Di ${pos <= 0.5 ? 'discount' : 'premium'} (${pct}% range ${pdA.timeframe})${good ? '' : bull ? ', zona mahal buat long' : ', zona murah buat short'}`)
    }
  }

  // ---- draw: A → B ----
  const dt = drawTarget(poi, a, ctx.pools, ctx.at)
  const { sl, risk } = dt
  const target: PoiStory['target'] = dt.target
  let blockers = 0
  let irl: PoiStory['irl'] = null
  let behindSl: PoiStory['behindSl'] = null
  if (risk > 0) {
    if (target) {
      const tp = target.price
      // opposite POIs with a cause, of this timeframe or bigger (≥ 1h), between the line and B; levels within 0.3 % = one
      const lv = ctx.pois
        .filter(
          (p) =>
            p.direction !== dir &&
            p.origin !== null &&
            TF_MS[p.timeframe] >= Math.max(TF_MS['1h'], TF_MS[tf]) &&
            p.kind !== 'OCL' &&
            p.activeFrom <= ctx.at &&
            (p.invalidT === null || closeT(p.invalidT, p.timeframe) > ctx.at) &&
            (bull ? p.level > poi.level && p.level < tp : p.level < poi.level && p.level > tp)
        )
        .map((p) => p.level)
        .sort((u, v) => u - v)
      for (let i = 0; i < lv.length; i++) if (i === 0 || lv[i]! / lv[i - 1]! - 1 > 0.003) blockers++
      fx.targetR = Math.min(target.distR, 20)
      fx.targetW = target.weight
      fx.blockers = blockers
      const A = taken[0] ? `A (${poolLabel(taken[0])}) sudah diambil → ` : ''
      const clean = target.distR >= 2 && blockers === 0
      add('draw', clean ? 1 : blockers > 0 ? -1 : 0, `${A}B: ${poolLabel(target)} di ${fmtR(target.distR)}${blockers ? `, ${blockers} POI lawan di jalan` : ', jalan bersih'}`)
    } else {
      fx.noTarget = 1
      add('draw', -1, `Nggak ada liquidity ${bull ? 'BSL' : 'SSL'} yang jelas ≥ 1R di depan`)
    }
    // internal range liquidity: nearest open opposite FVG in the trade direction
    for (const b of all) {
      for (const f of b.fvgsIdx) {
        if (f.direction === dir || closeT(b.candles[f.i + 2]?.t ?? Infinity, b.timeframe) > ctx.at) continue
        if (f.filledT !== null && closeT(f.filledT, b.timeframe) <= ctx.at) continue
        const lvl = bull ? f.bottom : f.top
        if (bull ? lvl <= poi.level : lvl >= poi.level) continue
        const distR = Math.abs(lvl - poi.level) / risk
        if (!irl || distR < irl.distR) irl = { price: lvl, tf: b.timeframe, distR }
      }
    }
    fx.irlR = irl ? Math.min(irl.distR, 20) : 20
    if (irl) add('draw', 0, `IRL terdekat: FVG ${irl.tf} terbuka di ${fmtR(irl.distR)}`)
    behindSl = poolBehindSl(poi, ctx.pools, sl, risk)
    fx.behindSlR = behindSl ? behindSl.distR : 2
    if (behindSl) add('draw', -1, `${poolLabel(behindSl)} ${fmtR(behindSl.distR)} di balik SL, bisa diburu dulu`)
    else add('draw', 1, 'Di balik SL (1R) nggak ada liquidity yang belum diambil')
  }

  return {
    id: poiId(poi),
    kind: poi.kind,
    timeframe: tf,
    direction: dir,
    level: poi.level,
    extreme: poi.extreme ?? null,
    origin: poi.origin,
    distPct: ((bull ? ctx.price - poi.level : poi.level - ctx.price) / ctx.price) * 100,
    touches,
    facts,
    taken,
    target,
    irl,
    blockers,
    behindSl,
    x: fx,
    plus: facts.filter((f) => f.sign > 0).length,
    minus: facts.filter((f) => f.sign < 0).length
  }
}
