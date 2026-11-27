/** Output types of the SMC detectors (docs/smc-rules.md). Times are candle open times (ms, UTC). */
import type { Timeframe } from './timeframes'

export type Dir = 'bullish' | 'bearish'
export type SwingLabel = 'HH' | 'LH' | 'HL' | 'LL'

/** §1 swing point (alternating high/low). `confirmedT` = candle on which it became known. */
export interface Swing {
  t: number
  kind: 'high' | 'low'
  price: number
  label: SwingLabel | null
  confirmedT: number
}

/** §2 Break of Structure = trend reversal (materi). */
export interface StructureBreak {
  t: number
  direction: Dir
  level: number
  swingT: number
}

/** §3 Order Block. `line` = entry level at the body edge; [wickEnd, line] = wick liquidity. */
export interface OrderBlock {
  t: number
  direction: Dir
  line: number
  wickEnd: number
  bodyFar: number
  hasFvg: boolean
  prevOpposite: boolean
  confirmedT: number
  hitT: number | null
  invalidT: number | null
  sweptT: number | null
}

/** §4 Fair Value Gap (first of the three candles at `t`). */
export interface Fvg {
  t: number
  direction: Dir
  top: number
  bottom: number
  touchedT: number | null
  filledT: number | null
}

/** §5 RBS (bullish) / SBR (bearish). */
export interface SrFlip {
  kind: 'RBS' | 'SBR'
  direction: Dir
  level: number
  sourceT: number
  breakT: number
  hasFvg: boolean
  hitT: number | null
  invalidT: number | null
}

/** §6 OCL; after a break it becomes OCL_BREAK with the opposite direction. */
export interface Ocl {
  t: number
  kind: 'OCL' | 'OCL_BREAK'
  direction: Dir
  level: number
  breakT: number | null
  hitT: number | null
  invalidT: number | null
}

/** §7 Quasimodo: entry at the first mountain's level. */
export interface Qm {
  direction: Dir
  level: number
  invalidLevel: number
  points: { h1: number; l1: number; h2: number; l2: number } // times; for bullish read as l1,h1,l2,h2
  activeT: number
  hitT: number | null
  invalidT: number | null
}

/** §10 Liquidity: OB wick zones (from the user's definition) and optional swing levels. */
export interface Liquidity {
  kind: 'wick' | 'swing'
  /** 'buy' = buy-side liquidity above highs, 'sell' = sell-side below lows. */
  side: 'buy' | 'sell'
  top: number
  bottom: number
  t: number
  sweptT: number | null
  equal: boolean
}

/**
 * Wyckoff trading range (indicator, score only). Accumulation = range after a decline, distribution =
 * range after a rally. Manipulation = spring (sweep below the range, close back in) / UTAD (above).
 * Breakout = closes outside the range for longer than the reclaim window → markup / markdown.
 */
export interface WyckoffRange {
  startT: number
  /** Close time of the candle on which the range became known. */
  knownT: number
  endT: number | null
  top: number
  bottom: number
  kind: 'accumulation' | 'distribution' | 'range'
  /** t = close time of the candle that confirmed the event. */
  manipulations: { t: number; kind: 'spring' | 'utad'; price: number }[]
  breakout: { t: number; direction: Dir } | null
}

export type WyckoffPhase = 'accumulation' | 'distribution' | 'range' | 'manipulation' | 'markup' | 'markdown'

export interface SmcAnalysis {
  timeframe: Timeframe
  /** Trend as of the last candle (null until the first structure break). */
  trend: Dir | null
  trendChanges: { t: number; trend: Dir }[]
  swings: Swing[]
  breaks: StructureBreak[]
  orderBlocks: OrderBlock[]
  fvgs: Fvg[]
  srFlips: SrFlip[]
  ocls: Ocl[]
  qms: Qm[]
  liquidity: Liquidity[]
  wyckoff: WyckoffRange[]
}

/** BO = Donchian channel breakout (M5 trend model; not an SMC POI, it is the reason of a trend trade). */
export type PoiKind = 'OB' | 'RBS' | 'SBR' | 'QM' | 'OCL' | 'OCL_BREAK' | 'BO' | 'SNR'

/** Display names (OB = Order Block; OCL Break is NOT an OB). */
export const POI_LABEL: Record<PoiKind, string> = {
  OB: 'OB',
  RBS: 'RBS',
  SBR: 'SBR',
  QM: 'QM',
  OCL: 'OCL',
  OCL_BREAK: 'OCL Break',
  BO: 'Breakout',
  SNR: 'Level A/V'
}

/**
 * Display name of a setup's parent POI. In M4 the parent is an order block that got broken, i.e. a
 * breaker — never shown as "OB" (an OB that failed is not an order block any more).
 */
export const setupPoiLabel = (model: string, kind: PoiKind): string => CONCEPT_LABEL[poiConcept(model, kind)]

/** Concept used for labels and filters: a breaker is its own concept, never lumped in with "OB". */
export type PoiConcept = PoiKind | 'BREAKER'
export const poiConcept = (model: string, kind: PoiKind): PoiConcept => (model === 'M4' ? 'BREAKER' : kind)
export const CONCEPT_LABEL: Record<PoiConcept, string> = { ...POI_LABEL, BREAKER: 'Breaker' }

/** "OB 4h → QM 15m"; M4 is just "Breaker 15m". */
export function setupPath(model: string, poiKind: PoiKind, poiTf: string, childKind: string, childTf: string): string {
  if (model === 'M4') return `Breaker ${childTf}`
  if (model === 'M5') return `Breakout ${poiTf}`
  if (model === 'M6') return `Radar pump → breakout ${childTf}`
  if (model === 'M7') return `MSNR level ${poiTf}`
  return `${POI_LABEL[poiKind]} ${poiTf} → ${childKind === 'BREAKER' ? 'Breaker' : childKind} ${childTf}`
}

/**
 * Why a POI exists (docs/entry-v2.md §1): it formed because liquidity was swept, or because price
 * tapped an active POI of a higher timeframe. A POI without an origin is not traded.
 */
export type PoiOrigin = 'sweep' | 'htfPoi' | 'sweep+htfPoi'

/** missed = price reached the TP before the limit entry filled (cancelled, no trade). */
export type SetupStatus = 'pending' | 'triggered' | 'win' | 'loss' | 'invalid' | 'expired' | 'missed'

/**
 * Entry models (docs/entry-v2.md §2). Entries are only ever at an OB, QM or breaker (never at an FVG/OCL).
 *  M0  old rule: POI hit → OB-shaped candle nearby (baseline for comparison only)
 *  M1  HTF POI hit → LTF CHoCH + displacement → limit at the small POI the leg created (QM > OB)
 *  M2a OB behind unswept liquidity (SSL/BSL in front of it) → limit at the OB
 *  M2b same OB, swept + tapped → LTF CHoCH → limit at the small POI (like M1)
 *  M4  breaker: OB broken after a liquidity sweep → limit on the retest (+FVG overlap = unicorn)
 *  M5  trend following (not SMC): 4h close beyond the N-candle Donchian channel, on the EMA side →
 *      limit at that close, SL k × ATR, exit by trailing only (no break-even, no TP). Lab 2y BTC/ETH/SOL: +0,15R.
 *  M6  radar pump (not SMC): 24h volume ≥ N × median or negative funding + volume → 1h close beyond the
 *      24h box → limit at that close, SL k × ATR, no TP (user takes profit by hand), trailing stop.
 *  M7  MSNR (Malaysian SnR, not from the course): fresh A/V level of the 4h closes in the daily storyline direction →
 *      limit at the level when price comes near, SL k × ATR beyond it, TP at the next fresh opposite level.
 *  M8  HTF POI with the trend (POI lab 2026-11-22): first touch of a 4h/1d RBS / SBR / OCL Break POI, only with
 *      BTC 4h and the coin's 1d trend on its side → limit at the POI line, SL beyond the POI, fixed TP 2R.
 *      Shadow paper by default (bot.shadowModels): never sends a live order.
 *  M9  bait → POI behind (user 2026-11-23, docs/smc-rules.md §11): a same-direction POI without origin in front of a
 *      1h/4h/1d POI got touched (the bait) → limit at the POI behind it, SL beyond it, fixed TP. Shadow paper by default.
 *  M10 HTF POI hit → entry-TF QM confirms (head inside the POI) → limit at the QM level, SL beyond the head (user 2026-11-23).
 *  M11 stacked OB (user 2026-11-25, lab15): first touch of a 1d OB whose candle also produced a same-direction OCL Break on
 *      a lower TF (1d → 4h/2h, 4h → 2h/1h), with the M8 machinery (BTC 4h + 1d trend, SL beyond the OB, TP max(3R, B)).
 */
export const ENTRY_MODELS = ['M0', 'M1', 'M2a', 'M2b', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11'] as const
export type EntryModel = (typeof ENTRY_MODELS)[number]
export const MODEL_LABEL: Record<EntryModel, string> = {
  M0: 'M0 lama (POI → OB valid)',
  M1: 'M1 POI besar → POI kecil',
  M2a: 'M2a liquidity grab (limit di OB)',
  M2b: 'M2b liquidity grab + CHoCH',
  M4: 'M4 breaker',
  M5: 'M5 trend breakout 4h',
  M6: 'M6 radar pump (TP manual)',
  M7: 'M7 MSNR level A/V fresh',
  M8: 'M8 POI HTF searah trend',
  M9: 'M9 umpan → POI di belakangnya',
  M10: 'M10 POI HTF kena → QM konfirmasi',
  M11: 'M11 OB HTF + OCL Break di TF turunan'
}

export type ChildKind = 'OB' | 'QM' | 'BREAKER' | 'BREAKOUT' | 'LEVEL'

/** Score/filter tags; FVG is information only (never an entry level). */
export type Confluence =
  | 'fvg'
  | 'sweep'
  | 'equalLiq'
  | 'displacement'
  | 'htfParent'
  | 'trendParent'
  | 'btc4h'
  | 'btc1h'
  | 'btcAgainst'
  | 'wyckoff'
  | 'manipulation'
  | 'wyckoffAgainst'
  | 'unicorn'
  | 'prevOpposite'
  /** Setup became known inside a killzone (London / New York open, config smc.killzonesUtc). Filter only, no score. */
  | 'killzone'
  /** Order flow from futures positioning (docs/entry-v2.md §10). Filters only, no score:
   *  oiConfirm = price moved in the trade direction over 24h and open interest rose (new money behind the move),
   *  oiFlush = open interest fell ≥ smc.flowOiFlushPct over 4h (positions flushed out at the POI),
   *  fundingContra = funding in the crowd's opposite tail (≤ 20th percentile of ~30 days for a long, ≥ 80th for a short). */
  | 'oiConfirm'
  | 'oiFlush'
  | 'fundingContra'
  /** Open interest did not fall more than smc.flowOiFadePct in the last 15 min (no short-covering breakout). */
  | 'oiHold'
  /** Coin "awake": 24h volume ≥ smc.anomalyVolMult × its 30-day median (1h). Filter tag, no score. */
  | 'anomaly'
  /** Entry on the right side of the HTF dealing range (smc.pdTimeframe): long in discount (below 50 %),
   *  short in premium (above 50 %). No long at the top, no short at the bottom. Filter tag, no score. */
  | 'pdZone'
  /** Bollinger momentum (smc.bbTimeframe): close on the trade side of the middle band, middle band sloping
   *  that way and the bands widening (expansion, not a squeeze). Filter tag, no score. */
  | 'bbMomentum'
  /** BTC dominance (BTCDOMUSDT, smc.btcDomTimeframe) on the trade's side: for an altcoin long BTCDOM is
   *  trending down (alts gaining on BTC), short BTCDOM trending up; for BTCUSDT itself the other way round.
   *  Filter tag, no score (user 2026-11-17). */
  | 'btcDom'
  /** M0: the parent POI's own liquidity (wick / extreme) was not taken between the hit and the OB valid
   *  (materi: the longer wick = liquidity still resting). Filter tag, no score (user 2026-11-18). */
  | 'poiLiq'
  /** No unswept swing high/low just behind the stop (within smc.slLiqZoneR × risk beyond the SL), so
   *  there is no obvious liquidity pool for price to run through the SL. Filter tag, no score. */
  | 'slLiqClear'
  /** The parent POI lines up with an active same-direction POI of another timeframe (≥ 1h) within
   *  smc.poiStackPct at the hit (user 2026-11-18: "pastiin POI ada di berbagai TF"). Filter tag, no score. */
  | 'poiStack'
  /** Liquidity lab 2026-11-22 (docs/entry-v2.md §22): an unswept 4h/1d swing on the stop side within 1R beyond the SL
   *  (price sits on HTF structure). Filter tag, no score. */
  | 'liqHtfBehind'
  /** At least smc.liqInPoiMin unswept swings (any TF) on the stop side between entry and SL. Filter tag, no score. */
  | 'liqInPoi'
  /** Price reached the entry taking at most one swing on the way (last 24h, within 3R in front). Filter tag, no score. */
  | 'cleanApproach'
  /** Inducement (docs/smc-rules.md §11): a same-direction POI without origin in front of the parent POI was touched
   *  on the way (≤ smc.baitDays). Filter tag, no score. */
  | 'baitTaken'
  /** Strict IDM: the first internal pullback (ltfPivot) of the leg that left the parent POI was swept. Filter tag. */
  | 'idmSwept'
  /** No other active same-direction POI (≥ 1h) behind the parent POI within smc.idmWindowAtr ATR. Filter tag. */
  | 'extremePoi'
  /** Strict IDM swept and no active same-direction POI (≥ 1h) between the parent POI and the IDM. Filter tag. */
  | 'decisionalPoi'
  /** CISD (docs/smc-rules.md §11): an entry-TF close beyond the open of the last opposite run, after the POI hit
   *  (≤ smc.confirmLookback candles before the setup is known). Filter tag. */
  | 'cisd'
  /** SMT divergence on 1h vs BTC (BTC vs ETH): in the last smc.smtWindowH hours only one of the two took the
   *  smc.smtRangeH-hour low (long) / high (short). Filter tag. */
  | 'smt'
  /** Inverse FVG: an opposite entry-TF FVG closed through in the setup direction, after the POI hit. Filter tag. */
  | 'ifvg'
  /** POI story (docs/smc-rules.md §12): the leg that created the parent POI had a body ≥ smc.storyDispAtr × ATR. Filter tag. */
  | 'dispStrong'
  /** POI story: a liquidity pool (B) ≥ 1R in front of the parent POI (strongest weight ÷ distance). Filter tag. */
  | 'liqTarget'
  /** POI story: no unswept pool within 1R beyond the parent POI's own stop (lab 300 coins: M0 +0,83R vs +0,12R). Filter tag. */
  | 'slPoolClear'
  /** Parent POI in the "expensive" half of the pdTimeframe range (long in premium / short in discount): momentum, the
   *  opposite of pdZone (lab 300 coins: M9 +0,33R vs −0,05R). Filter tag. */
  | 'pdPremium'
  /** Entry on the cheap side of the UTC daily open (long below it, short above): Power of 3 / intraday discount
   *  (lab 300 coins: M9 + pdPremium +0,54R vs +0,12R). Filter tag. */
  | 'dayOpenCheap'
  /** Golden ratio / OTE (user 2026-11-27): entry retraces smc.oteLow–oteHigh (0,618–0,786) of the last leg of the
   *  smc.oteLookback closed smc.oteTimeframe candles (legRetrace). Lab M8 1 year: +0,48R vs +0,23R per trade, but as a
   *  required tag it cuts too many trades → used for a bigger risk (bot.oteRiskMult). Filter tag. */
  | 'ote'

/** Confluences a user can require (bot settings, coin profiles, backtest filter). */
export const REQUIRABLE_CONFLUENCES = [
  'fvg',
  'sweep',
  'equalLiq',
  'displacement',
  'htfParent',
  'trendParent',
  'btc4h',
  'btc1h',
  'wyckoff',
  'manipulation',
  'unicorn',
  'prevOpposite',
  'killzone',
  'oiConfirm',
  'oiFlush',
  'fundingContra',
  'oiHold',
  'anomaly',
  'pdZone',
  'bbMomentum',
  'btcDom',
  'poiLiq',
  'slLiqClear',
  'poiStack',
  'liqHtfBehind',
  'liqInPoi',
  'cleanApproach',
  'baitTaken',
  'idmSwept',
  'extremePoi',
  'decisionalPoi',
  'cisd',
  'smt',
  'ifvg',
  'dispStrong',
  'liqTarget',
  'slPoolClear',
  'pdPremium',
  'dayOpenCheap',
  'ote'
] as const satisfies readonly Confluence[]

/** Confluences that can be required, with UI labels. */
export const CONFLUENCE_CHOICES: { key: Confluence; label: string }[] = [
  { key: 'fvg', label: 'FVG' },
  { key: 'trendParent', label: 'searah trend POI' },
  { key: 'sweep', label: 'sweep' },
  { key: 'htfParent', label: 'POI HTF' },
  { key: 'displacement', label: 'displacement' },
  { key: 'btc4h', label: 'BTC 4h searah' },
  { key: 'btc1h', label: 'BTC 1h searah' },
  { key: 'wyckoff', label: 'Wyckoff searah' },
  { key: 'manipulation', label: 'spring/UTAD' },
  { key: 'unicorn', label: 'unicorn' },
  { key: 'equalLiq', label: 'equal H/L' },
  { key: 'prevOpposite', label: 'candle sebelumnya berlawanan' },
  { key: 'killzone', label: 'killzone London/NY' },
  { key: 'oiConfirm', label: 'OI naik searah harga 24j' },
  { key: 'oiFlush', label: 'OI 4j flush' },
  { key: 'fundingContra', label: 'funding lawan crowd' },
  { key: 'oiHold', label: 'OI 15m tidak turun' },
  { key: 'anomaly', label: 'anomali: volume 24j ≥ 3× median' },
  { key: 'pdZone', label: 'long di discount / short di premium (HTF)' },
  { key: 'bbMomentum', label: 'momentum Bollinger searah' },
  { key: 'btcDom', label: 'BTC dominance mendukung (alt long saat BTCDOM turun)' },
  { key: 'poiLiq', label: 'M0: liquidity wick POI belum diambil' },
  { key: 'slLiqClear', label: 'tidak ada liquidity di belakang SL' },
  { key: 'poiStack', label: 'POI numpuk dengan POI TF lain (≥ 1h)' },
  { key: 'liqHtfBehind', label: 'liquidity 4h/1d ≤ 1R di balik SL' },
  { key: 'liqInPoi', label: 'banyak liquidity di antara entry dan SL' },
  { key: 'cleanApproach', label: 'harga datang tanpa nyapu liquidity (≤ 1)' },
  { key: 'baitTaken', label: 'umpan diambil: POI tanpa origin di depan POI sudah kena' },
  { key: 'idmSwept', label: 'IDM ketat (pullback internal pertama) sudah disapu' },
  { key: 'extremePoi', label: 'extreme POI (tidak ada POI searah di belakangnya)' },
  { key: 'decisionalPoi', label: 'decisional POI (POI terdekat di bawah/atas IDM)' },
  { key: 'cisd', label: 'CISD: close tembus open run lawan setelah POI kena' },
  { key: 'smt', label: 'SMT divergence 1h vs BTC (BTC vs ETH)' },
  { key: 'ifvg', label: 'inverse FVG searah setelah POI kena' },
  { key: 'dispStrong', label: 'cerita POI: displacement kuat saat POI lahir' },
  { key: 'liqTarget', label: 'cerita POI: ada liquidity B ≥ 1R di depan' },
  { key: 'slPoolClear', label: 'cerita POI: nggak ada liquidity ≤ 1R di balik SL POI' },
  { key: 'pdPremium', label: 'POI di sisi mahal (long di premium / short di discount)' },
  { key: 'dayOpenCheap', label: 'entry di sisi murah open harian (long di bawah open UTC)' },
  { key: 'ote', label: 'golden ratio / OTE: entry di 0,618–0,786 kaki terakhir' }
]

/** A candidate entry (never an order by itself). */
export interface Setup {
  id: string
  symbol: string
  model: EntryModel
  direction: Dir
  /** The reason for the trade: higher-TF POI that was hit (or the OB behind the liquidity for M2). */
  poi: { kind: PoiKind; timeframe: Timeframe; level: number; t: number; hitT: number | null; origin: PoiOrigin | null }
  /** Where the limit sits: the small POI created by the reaction. */
  child: { kind: ChildKind; timeframe: Timeframe; t: number; level: number; extreme: number; hasFvg: boolean; origin: PoiOrigin | null }
  entry: number
  sl: number
  /** Planned final TP (liquidity target, or entry ± exit.tpR when none / fixed-R mode). */
  tp: number
  /** Nearest unswept opposite liquidity at the time the setup became known. */
  tpLiquidity: number | null
  rr: number
  score: number
  confluence: Confluence[]
  reasons: string[]
  /** Entry-TF candle on whose close the setup became known. */
  createdT: number
  status: SetupStatus
  statusT: number | null
  /** Entry-TF candle on which the limit entry filled (null if it never did). */
  filledT: number | null
  /** Pending limit expires after N entry candles (model-specific; default smc.setupExpiryCandles). */
  expiryCandles?: number
}
