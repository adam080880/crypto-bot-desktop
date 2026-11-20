import { z } from 'zod'
import { ENTRY_MODELS, REQUIRABLE_CONFLUENCES, type EntryModel } from './smc'

/**
 * Risk guard config. The limits are enforced in code (src/main/risk), never via prompts.
 * Values are configurable, but the guard itself cannot be disabled.
 */
export const riskConfigSchema = z.object({
  /** Max realised+unrealised loss per UTC day, % of equity. Breach → bot halts automatically. */
  maxDailyLossPct: z.number().positive().max(100).default(3),
  /** Max simultaneously open positions. */
  maxOpenPositions: z.number().int().positive().max(50).default(3),
  /** Every order must carry a stop-loss. Not configurable on purpose. */
  requireStopLoss: z.literal(true).default(true),
  /** Max leverage allowed. Also caps the notional of risk-sized positions (equity × maxLeverage). */
  maxLeverage: z.number().int().min(1).max(125).default(5)
})

export const tradingModeSchema = z.enum(['paper', 'testnet'])
export type TradingMode = z.infer<typeof tradingModeSchema>

export const dataConfigSchema = z.object({
  /** Rolling retention for 1m candles (days). Older rows are pruned automatically. */
  oneMinuteRetentionDays: z.number().int().min(7).max(1100).default(183),
  /** Retention for 5m/15m/1h/4h derived candles (days). They outlive 1m on purpose. */
  derivedRetentionDays: z.number().int().min(7).max(3650).default(730),
  /** History depth for natively downloaded 1d/1w candles (days). */
  longHistoryDays: z.number().int().min(30).max(3650).default(730),
  /** Parallel symbols during backfill. */
  concurrency: z.number().int().min(1).max(16).default(4),
  /** Symbols never synced: indices, stablecoins, tokenised gold. */
  excludeSymbols: z.array(z.string()).default(['BTCDOMUSDT', 'USDCUSDT', 'XAUTUSDT', 'PAXGUSDT']),
  /** Skip symbols whose name has non-ASCII characters (e.g. Chinese-named memecoins). */
  excludeNonAscii: z.boolean().default(true),
  /** Fill gaps automatically on app start and on a schedule. */
  autoSync: z.boolean().default(true),
  /** REST catch-up interval for symbols not streamed live (minutes). */
  restPollMinutes: z.number().int().min(1).max(60).default(10),
  /** Streams per WebSocket connection (Binance max 1024). */
  streamsPerConnection: z.number().int().min(1).max(1024).default(200),
  /** Prevent system sleep while live data is running and the bot isn't halted. */
  keepAwake: z.boolean().default(true)
})
export type DataConfig = z.infer<typeof dataConfigSchema>

/** SMC detector parameters (docs/smc-rules.md). Defaults = answers confirmed by the user. */
export const smcConfigSchema = z.object({
  /** §1 Q1: candles left/right for a swing pivot. */
  pivot: z.number().int().min(1).max(10).default(3),
  /** §3 Q6: price must close beyond the OB candle's extreme within N candles. */
  obMoveCandles: z.number().int().min(1).max(50).default(5),
  /** §3 Q5c: minimum body/range ratio (doji filter). */
  minBodyRatio: z.number().min(0).max(1).default(0.1),
  /** §4 Q8: FVG may start up to N candles after the OB candle. */
  fvgMaxOffset: z.number().int().min(0).max(10).default(2),
  /** §4 Q9: minimum FVG size, % of price. */
  fvgMinPct: z.number().min(0).max(10).default(0.05),
  /** §6: an OCL Break must happen within N candles after the OCL pair ("oleh candle setelahnya"). */
  oclBreakMaxCandles: z.number().int().min(1).max(50).default(5),
  /** §6 (user): plain OCL only on high timeframes; below these only OCL Break is used. */
  oclPlainTimeframes: z.array(z.enum(['1m', '5m', '15m', '1h', '4h', '1d', '1w'])).default(['1d', '1w']),
  /** §3 Q7: SL buffer beyond the wick, % of price. */
  slBufferPct: z.number().min(0).max(5).default(0.1),
  /**
   * SL at least N × ATR(14) of the entry TF (lab 2y: tight stops sit inside the noise; 1× ATR adds
   * ±0,05–0,1R per trade). Applies to every SMC model, not M5 (own ATR stop). 0 = off.
   */
  minSlAtr: z.number().min(0).max(5).default(1),
  /** M4: breakers only from these timeframes (lab 2y: 15m −0,25R/trade, 1h/4h positive). */
  breakerTimeframes: z.array(z.enum(['15m', '1h', '4h', '1d'])).default(['1h', '4h']),
  /** M4 exit: fixed TP at N R without ladder (lab: 1h TP 1R +0,07R IS / +0,08R OOS). 0 = global exit. */
  breakerTpR: z.number().min(0).max(20).default(1),
  /** §7: mountain 2's body must break mountain 1's wick ("biasanya"; user-confirmed). */
  qmRequireBodyBreak: z.boolean().default(true),
  /** §8 Q14 */
  poiTimeframes: z.array(z.enum(['5m', '15m', '1h', '4h', '1d'])).default(['1d', '4h', '1h']),
  entryTimeframe: z.enum(['1m', '5m', '15m', '1h']).default('15m'),
  sameTfPoi: z.boolean().default(true),
  /** §8 Q15: OB valid must form within N entry candles after the POI hit. */
  obValidMaxCandles: z.number().int().min(1).max(100).default(10),
  /** §8: how close the OB valid's wick must come to the POI level, % of price. */
  obValidNearPct: z.number().min(0).max(5).default(0.3),
  /** Pending setups expire after N entry candles. */
  setupExpiryCandles: z.number().int().min(1).max(2000).default(96),
  /** §8 Q17 */
  minRR: z.number().min(0.5).max(20).default(2),
  /** §10: swing highs/lows within this % count as equal. */
  equalPct: z.number().min(0).max(2).default(0.1),

  // ---- entry v2 (docs/entry-v2.md) ----
  /** Entry models detected (screener/chart/backtest). M0 = old rule, kept as a baseline. */
  models: z.array(z.enum(ENTRY_MODELS)).default([...ENTRY_MODELS]),
  /** Pivot size for the small (entry-TF) structure used by CHoCH. */
  ltfPivot: z.number().int().min(1).max(10).default(2),
  /** M1/M2b: the LTF CHoCH must happen within N entry candles after the POI was hit. */
  refineWindow: z.number().int().min(2).max(200).default(16),
  /** Displacement: one candle of the CHoCH leg has body ≥ N × ATR (or the leg leaves an FVG). */
  dispBodyAtr: z.number().min(0).max(10).default(1.2),
  requireDisplacement: z.boolean().default(true),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  /** Sweep: wick beyond liquidity and a close back inside within N candles (else it is a breakout). */
  sweepReclaimCandles: z.number().int().min(0).max(10).default(2),
  /** M2: the OB must sit at most N % beyond the liquidity in front of it. */
  grabObDistPct: z.number().min(0.05).max(10).default(1),
  /** Origin: a HTF POI counts as tapped when the reaction candle reaches within N % of it. */
  originNearPct: z.number().min(0).max(5).default(0.15),
  /** Origin: how many previous swings of the same side may be the swept liquidity. */
  originSwings: z.number().int().min(1).max(10).default(3),
  /** Parent POIs (the reason) must have an origin too (sweep / HTF POI). */
  parentNeedsOrigin: z.boolean().default(true),
  /** Plain OCL may be a parent (reason) only from these timeframes, every model incl. M0. [] = never (user
   *  2026-11-20: plain HTF OCL is not a POI, only the HTF OCL Break is; still drawn on the chart). */
  oclParentTimeframes: z.array(z.enum(['1h', '4h', '1d', '1w'])).default([]),
  /** Wyckoff range: N candles whose range ≤ wyRangeAtr × ATR (ATR measured before the range). */
  wyRangeCandles: z.number().int().min(5).max(200).default(24),
  wyRangeAtr: z.number().min(1).max(30).default(4),
  wyckoffTimeframes: z.array(z.enum(['15m', '1h', '4h', '1d'])).default(['4h', '1h']),
  /** Killzones (UTC hours [from, to)): London open 07–10, New York open 12–15 (winter time). Confluence 'killzone'. */
  killzonesUtc: z
    .array(z.tuple([z.number().int().min(0).max(23), z.number().int().min(1).max(24)]))
    .max(6)
    .default([
      [7, 10],
      [12, 15]
    ]),

  // ---- M5 trend following (not SMC; lab: docs/entry-v2.md §7) ----
  /** Timeframe whose close must break the channel. */
  trendTimeframe: z.enum(['1h', '4h', '1d']).default('4h'),
  /** Donchian channel length (candles) the close must break. */
  trendChannel: z.number().int().min(5).max(200).default(20),
  /** Trend filter: close on the right side of this EMA (0 = off). */
  trendEma: z.number().int().min(0).max(500).default(200),
  /** SL = entry ∓ trendAtrMult × ATR (= 1R). */
  trendAtrMult: z.number().min(0.5).max(10).default(3),
  /** Limit entry at the breakout close ∓ N × ATR (0 = at the close). */
  trendEntryOffsetAtr: z.number().min(0).max(3).default(0),
  /** Only the first close beyond the channel (the previous close was still inside). */
  trendFreshOnly: z.boolean().default(true),
  trendLongOnly: z.boolean().default(false),
  /** Pending limit expires after N entry-TF candles. */
  trendExpiryCandles: z.number().int().min(1).max(500).default(16),
  /** Exit: no break-even, no TP; every trailStepR of new best R the SL goes to best − trailGapR. */
  trendTrailGapR: z.number().min(0.5).max(10).default(1),
  trendTrailStepR: z.number().min(0.05).max(5).default(0.25),

  // ---- M6 radar pump (docs/entry-v2.md §12–13): radar hit → 1h close beyond the 24h box ----
  /** Radar: 24h quote volume ≥ N × median of the previous 30 days … */
  m6VolMult: z.number().min(1).max(50).default(8),
  /**
   * Tag `anomaly` (any model): 24h volume ≥ N × 30-day median at the time the setup is known. Lab
   * 20 alts 2y: setups on awake coins did better, not worse (M5 +0,21–0,37R vs +0,01R; M4, M1 too).
   */
  anomalyVolMult: z.number().min(1).max(50).default(3),
  /** … or funding ≤ this (fraction per settlement) with volume ≥ m6FundingVolMult. */
  m6FundingMax: z.number().min(-0.05).max(0).default(-0.0005),
  m6FundingVolMult: z.number().min(1).max(50).default(3),
  /** Wait at most N hours after the radar hit for the breakout close. */
  m6WatchHours: z.number().int().min(1).max(240).default(72),
  /** No new radar hit for the same coin within N hours after a hit. */
  m6CooldownHours: z.number().int().min(0).max(720).default(72),
  /** SL = entry ∓ N × ATR(24) of 1h (= 1R). */
  m6AtrMult: z.number().min(0.5).max(10).default(3),
  m6LongOnly: z.boolean().default(true),
  /** Pending limit at the breakout close expires after N entry-TF candles. */
  m6ExpiryCandles: z.number().int().min(1).max(500).default(16),
  /** Exit: no TP (manual), no break-even; every m6TrailStepR of new best R the SL goes to best − m6TrailGapR. */
  m6TrailGapR: z.number().min(0.5).max(20).default(2),
  m6TrailStepR: z.number().min(0.05).max(5).default(0.25),
  /**
   * M7 MSNR (Malaysian SnR, user 2026-11-20, docs/entry-v2.md §20; rules from public sources, not the course).
   * A/V levels = peaks/valleys of the `msnrTimeframe` closes (line chart, pivot msnrPivot each side); fresh until a
   * wick touches them. Storyline = daily close vs EMA(msnrStoryEma) with that EMA sloping the same way (over 3 days).
   * Limit at a fresh level in the storyline direction once price comes within msnrNearAtr × ATR(14); SL msnrSlAtr × ATR
   * beyond it; TP = next fresh opposite level, at least msnrMinRR. Lab 150 coins / 6 months (fee, fill needs 0.1% through):
   * +0,22R (IS +0,12 / OOS +0,43), 6 of 7 months positive.
   */
  msnrTimeframe: z.enum(['1h', '4h', '1d']).default('4h'),
  msnrPivot: z.number().int().min(1).max(10).default(2),
  msnrStoryEma: z.number().int().min(5).max(200).default(20),
  msnrSlAtr: z.number().min(0.1).max(5).default(1),
  msnrMinRR: z.number().min(0.5).max(10).default(1.5),
  msnrNearAtr: z.number().min(0.1).max(10).default(1),
  /** A level older than this (days since it became known) is not traded any more. */
  msnrMaxAgeDays: z.number().min(1).max(90).default(20),
  /** Pending limit expires after N entry-TF candles (96 × 15m = 24h). */
  msnrExpiryCandles: z.number().int().min(1).max(1000).default(96),

  // ---- order flow from futures positioning (open interest / funding), docs/entry-v2.md §10 ----
  /** oiFlush: open interest down at least this % over the last 4h. */
  flowOiFlushPct: z.number().min(0).max(50).default(1),
  /** fundingContra: funding percentile (last ~90 settlements) ≤ this for a long, ≥ 1 − this for a short. */
  flowFundingPct: z.number().min(0).max(0.5).default(0.2),
  /** oiHold: open interest did not fall more than this % over the last 15 min (5m snapshots). */
  flowOiFadePct: z.number().min(0).max(10).default(0.3),

  // ---- premium / discount + Bollinger momentum (user, 2026-11-16): tags pdZone / bbMomentum ----
  /** Dealing range = high/low of the last pdLookback closed candles of this timeframe; 50 % = equilibrium. */
  pdTimeframe: z.enum(['1h', '4h', '1d']).default('4h'),
  /** 60 × 4h ≈ 10 days. */
  pdLookback: z.number().int().min(10).max(500).default(60),
  /** Long only below (and short only above) this fraction of the range; 0.5 = equilibrium. */
  pdLevel: z.number().min(0.2).max(0.8).default(0.5),
  bbTimeframe: z.enum(['15m', '1h', '4h']).default('1h'),
  bbPeriod: z.number().int().min(5).max(100).default(20),
  bbStdDev: z.number().min(0.5).max(4).default(2),
  /** Middle-band slope and band-width change are measured over N candles. */
  bbSlopeCandles: z.number().int().min(1).max(20).default(3),
  /** Trend timeframe of BTC dominance (BTCDOMUSDT, fetched from Binance, not stored) for the btcDom tag. */
  btcDomTimeframe: z.enum(['1h', '4h']).default('4h'),
  /** slLiqClear: look for unswept swing liquidity up to this many R beyond the SL. */
  slLiqZoneR: z.number().min(0.1).max(5).default(1),
  /** poiStack: another timeframe's POI counts when its level is within this % of the parent POI's level. */
  poiStackPct: z.number().min(0.01).max(5).default(0.3),
  /** Timeframes on which M0 may use an OCL Break as its POI. 2026-11-18 only 1w; user 2026-11-20: the HTF
   *  OCL Break replaces the plain OCL, so 4h/1d/1w (bot.poiTimeframes still limits what the bot trades). [] = never. */
  m0OclBreakTimeframes: z.array(z.enum(['1h', '4h', '1d', '1w'])).default(['4h', '1d', '1w']),
  /** M0 only enters while the POI's wick liquidity is still resting (tag poiLiq). Lab 40 coins / 6 months:
   *  without it −0.21R vs −0.10R per trade (OOS −0.34 vs −0.13). */
  m0RequirePoiLiq: z.boolean().default(true)
})
export type SmcConfig = z.infer<typeof smcConfigSchema>

/**
 * Exit plan shared by backtest and bot (docs/entry-v2.md §4). Tiered trailing:
 * each ladder step fires once price reaches `atR`: close `closePct` % of the ORIGINAL size and move
 * the SL to `slToR` (0 = break-even incl. fees). After the last step the SL trails every
 * `trailStepR` at (best R − `trailGapR`). Default = user's plan: 1R → BE, 3R → take 50 %, SL to 1R.
 */
export const exitConfigSchema = z.object({
  /** liquidity: TP at the nearest opposite liquidity (fallback tpR) · fixedR: TP at tpR · trail: no TP, ladder/trailing only. */
  tpMode: z.enum(['liquidity', 'fixedR', 'trail']).default('liquidity'),
  tpR: z.number().min(0.5).max(50).default(5),
  ladder: z
    .array(z.object({ atR: z.number().min(0.25).max(50), slToR: z.number().min(0).max(49), closePct: z.number().min(0).max(100) }))
    .max(6)
    .default([
      { atR: 1, slToR: 0, closePct: 0 },
      { atR: 3, slToR: 1, closePct: 50 }
    ]),
  /** 0 = off. */
  trailStepR: z.number().min(0).max(10).default(1),
  trailGapR: z.number().min(0.5).max(20).default(2),
  /**
   * Order-flow hold (user): after entry a strong move leaves an FVG in the trade direction on
   * `orderFlowTf`; once that FVG is retested and holds (a candle trades into it and closes back on
   * the right side), the ladder/trailing stops and the position is held to TP / manual close with
   * the SL just beyond the retest extreme. A close through the FVG breaks the order flow → ladder resumes.
   */
  orderFlowHold: z.boolean().default(true),
  orderFlowTf: z.enum(['5m', '15m', '1h']).default('15m'),
  /**
   * What confirms the order flow: fvg = FVG in the trade direction retested and held; wick = a
   * reactive rejection candle back at the entry area (wick ≥ wickRatio of the range and ≥ 1.5 × body,
   * close on the trade side of the entry) → the POI is effective.
   */
  orderFlowSignals: z.array(z.enum(['fvg', 'wick'])).min(1).default(['fvg', 'wick']),
  orderFlowWickRatio: z.number().min(0.3).max(0.95).default(0.5),
  /**
   * Move the stop to the retest / wick extreme when the order flow confirms. Off (user, 2026-11-19):
   * lab 100 coins, bot filters: M0 +0,26R → +0,35R (IS and OOS), M2a +0,28R → +0,37R with the stop left
   * where it was. The order flow still holds the position (no partials, trailing paused).
   */
  orderFlowMoveSl: z.boolean().default(false),
  /**
   * Tight stop (user): when |entry − SL| is below tightSlPct % of the entry, 1R is mostly fees and
   * noise, so the break-even step (slToR 0) fires at tightBeAtR at the earliest and locks
   * tightBeLockR net of fees instead of plain BE. Stops ≥ tightSlPct keep the normal BE step. 0 = off.
   */
  tightSlPct: z.number().min(0).max(10).default(1),
  tightBeAtR: z.number().min(0.5).max(10).default(2),
  tightBeLockR: z.number().min(0).max(5).default(0.5)
})
export type ExitConfig = z.infer<typeof exitConfigSchema>

/** Where to fetch the official actual for an event (Fase 5). */
export const actualSourceSchema = z.object({
  provider: z.enum(['bls', 'fred']),
  series: z.string().regex(/^[A-Za-z0-9_]{2,40}$/),
  /** level = latest value; pct_mom / pct_yoy = % change vs 1 / 12 periods back; diff = change vs previous. */
  transform: z.enum(['level', 'pct_mom', 'pct_yoy', 'diff']),
  /** Multiply the result (e.g. 0.001 to turn persons into K). */
  scale: z.number().default(1),
  decimals: z.number().int().min(0).max(4).default(1),
  /** The observation must be at least this recent: start of (event's unit) − n units. */
  refLag: z.object({ unit: z.enum(['day', 'week', 'month', 'quarter']), n: z.number().int().min(-5).max(12) })
})
export type ActualSourceConfig = z.infer<typeof actualSourceSchema>

export const interpretationRuleSchema = z.object({
  key: z.string().min(1),
  /** Case-insensitive regex matched against the event title. */
  match: z.string().min(1),
  /** true: actual > forecast is good for USD (e.g. CPI). false: inverted (unemployment, claims). */
  higherIsGoodForUsd: z.boolean(),
  /** |actual − forecast| must exceed this to count; otherwise neutral. */
  threshold: z.number().min(0).default(0),
  source: actualSourceSchema.optional()
})
export type InterpretationRule = z.infer<typeof interpretationRuleSchema>

const M1 = { unit: 'month', n: 1 } as const
export const DEFAULT_RULES: InterpretationRule[] = [
  { key: 'cpi_mom', match: '^CPI m/m$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'bls', series: 'CUSR0000SA0', transform: 'pct_mom', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'core_cpi_mom', match: '^Core CPI m/m$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'bls', series: 'CUSR0000SA0L1E', transform: 'pct_mom', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'cpi_yoy', match: '^CPI y/y$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'bls', series: 'CUUR0000SA0', transform: 'pct_yoy', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'core_cpi_yoy', match: '^Core CPI y/y$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'bls', series: 'CUUR0000SA0L1E', transform: 'pct_yoy', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'ppi_mom', match: '^PPI m/m$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'bls', series: 'WPSFD4', transform: 'pct_mom', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'core_ppi_mom', match: '^Core PPI m/m$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'bls', series: 'WPSFD49104', transform: 'pct_mom', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'nfp', match: '^Non-Farm Employment Change$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'bls', series: 'CES0000000001', transform: 'diff', scale: 1, decimals: 0, refLag: M1 } },
  { key: 'unemployment_rate', match: '^Unemployment Rate$', higherIsGoodForUsd: false, threshold: 0, source: { provider: 'bls', series: 'LNS14000000', transform: 'level', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'ahe_mom', match: '^Average Hourly Earnings m/m$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'bls', series: 'CES0500000003', transform: 'pct_mom', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'claims', match: '^Unemployment Claims$', higherIsGoodForUsd: false, threshold: 0, source: { provider: 'fred', series: 'ICSA', transform: 'level', scale: 0.001, decimals: 0, refLag: { unit: 'week', n: 1 } } },
  { key: 'retail_mom', match: '^Retail Sales m/m$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'fred', series: 'RSAFS', transform: 'pct_mom', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'core_retail_mom', match: '^Core Retail Sales m/m$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'fred', series: 'RSFSXMV', transform: 'pct_mom', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'core_pce_mom', match: '^Core PCE Price Index m/m$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'fred', series: 'PCEPILFE', transform: 'pct_mom', scale: 1, decimals: 1, refLag: M1 } },
  { key: 'gdp_adv', match: '^Advance GDP q/q$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'fred', series: 'A191RL1Q225SBEA', transform: 'level', scale: 1, decimals: 1, refLag: { unit: 'quarter', n: 1 } } },
  { key: 'jolts', match: '^JOLTS Job Openings$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'fred', series: 'JTSJOL', transform: 'level', scale: 0.001, decimals: 2, refLag: { unit: 'month', n: 2 } } },
  { key: 'fed_funds', match: '^Federal Funds Rate$', higherIsGoodForUsd: true, threshold: 0, source: { provider: 'fred', series: 'DFEDTARU', transform: 'level', scale: 1, decimals: 2, refLag: { unit: 'day', n: -1 } } },
  // No free official feed → interpreted only when the actual is entered manually.
  { key: 'ism_mfg', match: '^ISM Manufacturing PMI$', higherIsGoodForUsd: true, threshold: 0 },
  { key: 'ism_services', match: '^ISM Services PMI$', higherIsGoodForUsd: true, threshold: 0 },
  { key: 'uom_sentiment', match: 'UoM Consumer Sentiment$', higherIsGoodForUsd: true, threshold: 0 },
  { key: 'adp', match: '^ADP Non-Farm Employment Change$', higherIsGoodForUsd: true, threshold: 0 }
]

export const newsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  currencies: z.array(z.string().length(3)).default(['USD']),
  impacts: z.array(z.enum(['High', 'Medium', 'Low'])).default(['High', 'Medium']),
  /** News window around these impacts: no new positions unless the news strategy is on. */
  windowImpacts: z.array(z.enum(['High', 'Medium', 'Low'])).default(['High']),
  windowBeforeMin: z.number().int().min(0).max(240).default(15),
  windowAfterMin: z.number().int().min(0).max(240).default(30),
  newsStrategyEnabled: z.boolean().default(false),
  /** inverse: USD bearish → crypto bullish (default). same: follow USD. off: no crypto bias. */
  cryptoBiasMode: z.enum(['inverse', 'same', 'off']).default('inverse'),
  /** Symbols analysed for trade-on-news candidates (watchlist is added automatically). */
  candidateSymbols: z.array(z.string().regex(/^[A-Z0-9]{2,30}$/)).default(['BTCUSDT', 'ETHUSDT']),
  reactionHorizonsMin: z.array(z.number().int().min(1).max(1440)).default([5, 15, 60]),
  feedRefreshMinutes: z.number().int().min(15).max(240).default(60),
  rules: z.array(interpretationRuleSchema).default(DEFAULT_RULES)
})
export type NewsConfig = z.infer<typeof newsConfigSchema>

/** Fase 6: Claude as periodic analyst (Agent SDK). Read-only; never sends orders. */
export const claudeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default('claude-opus-5-5'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  /** Run after USD news actuals come out (one run per release minute). */
  triggerOnNews: z.boolean().default(true),
  /** Optional periodic run in minutes; 0 = off (default: only on news / manual). */
  intervalMinutes: z.number().int().min(0).max(1440).default(0),
  /** Hard stop per run (Agent SDK maxBudgetUsd). */
  maxBudgetUsd: z.number().min(0.05).max(10).default(0.5),
  /** Daily spend cap; runs are skipped once reached. */
  dailyBudgetUsd: z.number().min(0.1).max(100).default(3),
  maxTurns: z.number().int().min(1).max(20).default(8),
  /** Path to the Claude Code executable; '' = auto (PATH + standard install locations). */
  executable: z.string().max(500).default('')
})
export type ClaudeConfig = z.infer<typeof claudeConfigSchema>

/** Screener over stored data: entry material across all synced symbols. Candidates only. */
export const screenerConfigSchema = z.object({
  /** Rescan one minute after every 15m close (and once after startup). */
  autoScan: z.boolean().default(true),
  /** "Harga dekat POI": max distance to an active POI, % of price. */
  nearPoiPct: z.number().min(0.05).max(10).default(1),
  poiTimeframes: z.array(z.enum(['15m', '1h', '4h'])).default(['1h', '4h']),
  /** "BOS baru": last structure break on these timeframes within N hours. */
  bosTimeframes: z.array(z.enum(['15m', '1h', '4h'])).default(['1h', '4h']),
  bosRecentHours: z.number().int().min(1).max(168).default(24),
  /** Skip symbols whose newest 1m candle is older than this (not synced / delisted). */
  maxDataAgeMin: z.number().int().min(5).max(1440).default(120),
  /** Desktop notification for new OB valid setups found by an automatic scan. */
  notify: z.boolean().default(true)
})
export type ScreenerConfig = z.infer<typeof screenerConfigSchema>

/**
 * Fase 7 bot. Entries come from screener setups (HTF POI → OB valid on the entry TF) on the top
 * crypto coins by volume, gated by a fresh Claude analysis (bias == direction, confidence ≥ min).
 * `live` is never set through a config patch: it needs the explicit confirmation IPC.
 */
const confList = z.array(z.enum(REQUIRABLE_CONFLUENCES))
export const modelConfluenceSchema = z.object(Object.fromEntries(ENTRY_MODELS.map((m) => [m, confList.default([])])) as Record<EntryModel, z.ZodDefault<typeof confList>>)
export type ModelConfluence = z.infer<typeof modelConfluenceSchema>

/**
 * Confluence lab 2026-11-19 (60 top-volume coins, 6 months, OOS = last 60 days, bot exits, after fees;
 * docs/entry-v2.md §18). M1/M2b: nothing positive, kept at the old SMC list. M6: radar = the signal.
 */
export const RECOMMENDED_MODEL_CONFLUENCE: ModelConfluence = {
  M0: ['prevOpposite', 'slLiqClear'], // +0,23R (IS +0,18 / OOS +0,31) vs +0,16R without
  M1: ['fvg', 'trendParent', 'pdZone'],
  M2a: ['trendParent'], // n 39 only; pdZone hurts M2a
  M2b: ['fvg', 'trendParent', 'pdZone'],
  M4: ['fvg', 'oiConfirm', 'slLiqClear'], // 300 koin: +0,27R (IS +0,27 / OOS +0,28) vs −0,04R; fvg+btc1h+slLiqClear +0,17R
  M5: ['btc1h', 'anomaly'], // +0,23R (IS +0,24 / OOS +0,22); old oiConfirm+oiHold: OOS −0,23R
  M6: [],
  M7: [] // MSNR: the level + storyline is the signal
}

export const botConfigSchema = z.object({
  /** Bot running (paper unless `live`). */
  enabled: z.boolean().default(false),
  /** Require a fresh Claude analysis (bias + confidence) before entering. Off = pure ICT/SMC math (user). */
  requireClaude: z.boolean().default(false),
  /** Entry models the bot may trade (docs/entry-v2.md). M0/M2a lost money in the 2-year backtest. */
  models: z.array(z.enum(ENTRY_MODELS)).min(1).default(['M1', 'M2b', 'M4', 'M5', 'M6']),
  /**
   * Required confluences per entry model (user 2026-11-19): every listed tag must be on the setup.
   * Each model tags different things (M0 never has `fvg`, M4 never `prevOpposite`), so one shared list
   * cannot serve all. Replaces `requireConfluence` (M0–M4) + `trendRequireConfluence` (M5), migrated in AppState.
   */
  modelConfluence: modelConfluenceSchema.default(RECOMMENDED_MODEL_CONFLUENCE),
  minScore: z.number().int().min(0).max(20).default(0),
  /** Real orders on Binance USDT-M. Off by default; switched on only via `bot:setLive` + confirmation. */
  live: z.boolean().default(false),
  minConfidence: z.number().int().min(0).max(100).default(70),
  /**
   * Risk-based sizing: max loss per order if the SL is hit, % of equity.
   * Size = equity × riskPerTradePct ÷ |entry − SL| distance (capped by risk.maxLeverage).
   */
  riskPerTradePct: z.number().positive().max(100).default(1),
  /**
   * Base for the risk % (user, 2026-11-20): 0 = the current equity (size follows the balance); > 0 = a fixed
   * USDT base, so 1R stays riskPerTradePct % of this amount however the balance moves. Notional / leverage
   * limits still use the real equity.
   */
  riskBaseUsdt: z.number().min(0).max(1e9).default(0),
  /** Only the N most traded crypto perpetuals (24h quote volume); no TradFi/commodities/indices. */
  topVolume: z.number().int().min(5).max(300).default(100),
  /** M0/M1/M2a/M2b: the parent POI (the reason) must come from these timeframes. M4/M5/M6 are not limited. */
  poiTimeframes: z.array(z.enum(['15m', '1h', '4h', '1d'])).min(1).default(['1h', '4h', '1d']),
  /** Only take setups confirmed within the last N minutes (no chasing old ones). */
  maxSetupAgeMin: z.number().int().min(1).max(525600).default(60),
  /** (requireClaude) The Claude analysis must be newer than the setup and at most this old. */
  maxAnalysisAgeMin: z.number().int().min(1).max(525600).default(90),
  /**
   * Auto blacklist (user, 2026-11-16): a coin with ≥ N losing trades (SL, not BE) in the last
   * slBlacklistHours gets no new entries until the oldest of those N leaves the window. 0 = off.
   */
  slBlacklistCount: z.number().int().min(0).max(20).default(3),
  slBlacklistHours: z.number().int().min(1).max(2160).default(168),
  /**
   * Max active trades (pending + open) in one direction (user 2026-11-18: 5 alt shorts filled within 35 min
   * while BTC pumped and all hit SL together; alts move with BTC, so same-side trades are one bet). 0 = off.
   */
  maxSameDirection: z.number().int().min(0).max(50).default(0),
  /** Bot page statistics count trades opened at/after this time (ms; 0 = all). User 2026-11-18: judge a new setup alone. */
  statsSince: z.number().int().min(0).default(0),
  /** Paper account starting balance (USDT). */
  paperEquity: z.number().positive().max(1e9).default(10)
})
export type BotConfig = z.infer<typeof botConfigSchema>

/**
 * Pump radar (docs/entry-v2.md §12): notify only, never orders. Lab 2y, 346 coins: a 24h quote
 * volume ≥ 8× its 30-day median, or funding ≤ −0,05 % with volume ≥ 3×, gives a ≥ 20 % move within
 * 24h 5,3–6,8× more often than average (±12–18 alerts/day over 346 coins, mostly pumps). Looser
 * thresholds (3× / −0,02 %) are weaker and ~40 alerts/day. Calm/compressed coins move less, not more.
 * As an automatic model it lost money out of sample (slippage), so it only alerts.
 */
export const radarConfigSchema = z.object({
  enabled: z.boolean().default(true),
  volMult: z.number().min(1).max(50).default(8),
  /** Funding (fraction per settlement, −0.0002 = −0,02 %) at or below this … */
  fundingMax: z.number().min(-0.05).max(0).default(-0.0005),
  /** … together with volume ≥ this multiple. */
  fundingVolMult: z.number().min(1).max(50).default(3),
  /** No new alert for the same coin within N hours. */
  cooldownHours: z.number().int().min(1).max(168).default(24)
})
export type RadarConfig = z.infer<typeof radarConfigSchema>

/** Discord webhook notifications (URL is a secret: discord.webhookUrl). */
export const notifyConfigSchema = z.object({
  discord: z.boolean().default(true),
  radar: z.boolean().default(true),
  /** Bot order events: entry placed, filled, SL moved, closed. */
  botOrders: z.boolean().default(true),
  /** Bot warnings and errors. */
  botWarnings: z.boolean().default(true),
  /** New screener setups from the automatic scan. */
  screener: z.boolean().default(false)
})
export type NotifyConfig = z.infer<typeof notifyConfigSchema>

export const appConfigSchema = z.object({
  mode: tradingModeSchema.default('paper'),
  /** ccxt exchange id; Binance USDT-M perpetual by default. */
  exchangeId: z.string().default('binanceusdm'),
  /** Binance symbol ids (e.g. BTCUSDT). Always streamed live. */
  watchlist: z.array(z.string().regex(/^[A-Z0-9]{2,30}$/)).default(['BTCUSDT', 'ETHUSDT']),
  risk: riskConfigSchema.default(riskConfigSchema.parse({})),
  data: dataConfigSchema.default(dataConfigSchema.parse({})),
  smc: smcConfigSchema.default(smcConfigSchema.parse({})),
  news: newsConfigSchema.default(newsConfigSchema.parse({})),
  claude: claudeConfigSchema.default(claudeConfigSchema.parse({})),
  screener: screenerConfigSchema.default(screenerConfigSchema.parse({})),
  bot: botConfigSchema.default(botConfigSchema.parse({})),
  exit: exitConfigSchema.default(exitConfigSchema.parse({})),
  radar: radarConfigSchema.default(radarConfigSchema.parse({})),
  notify: notifyConfigSchema.default(notifyConfigSchema.parse({}))
})

export type RiskConfig = z.infer<typeof riskConfigSchema>
export type AppConfig = z.infer<typeof appConfigSchema>

export const defaultAppConfig: AppConfig = appConfigSchema.parse({})

/** Exit plan of M5 (trend): no break-even step, no partials, no TP — trailing only (best − gapR every stepR). */
/** Exit of M6 (radar pump): no TP (the user takes profit by hand), no break-even, trailing stop only. */
export function m6Exit(smc: Pick<SmcConfig, 'm6TrailGapR' | 'm6TrailStepR'>): Pick<ExitConfig, 'tpMode' | 'tpR' | 'ladder' | 'trailStepR' | 'trailGapR' | 'orderFlowHold'> {
  return { tpMode: 'trail', tpR: 50, ladder: [], trailStepR: smc.m6TrailStepR, trailGapR: smc.m6TrailGapR, orderFlowHold: false }
}

/** Exit of M7 (MSNR): TP at the next fresh level (setup.tpLiquidity), no ladder, no trailing — as in the lab. */
export function msnrExit(): Pick<ExitConfig, 'tpMode' | 'tpR' | 'ladder' | 'trailStepR' | 'orderFlowHold'> {
  return { tpMode: 'liquidity', tpR: 3, ladder: [], trailStepR: 0, orderFlowHold: false }
}

/** Exit of M4 (breaker) when smc.breakerTpR > 0: fixed TP, no ladder, no trailing. */
export function breakerExit(smc: Pick<SmcConfig, 'breakerTpR'>): Pick<ExitConfig, 'tpMode' | 'tpR' | 'ladder' | 'trailStepR' | 'orderFlowHold'> | null {
  return smc.breakerTpR > 0 ? { tpMode: 'fixedR', tpR: smc.breakerTpR, ladder: [], trailStepR: 0, orderFlowHold: false } : null
}

export function trendExit(smc: Pick<SmcConfig, 'trendTrailGapR' | 'trendTrailStepR'>): Pick<ExitConfig, 'tpMode' | 'tpR' | 'ladder' | 'trailStepR' | 'trailGapR' | 'orderFlowHold' | 'orderFlowTf' | 'orderFlowSignals' | 'orderFlowWickRatio'> {
  return { tpMode: 'trail', tpR: 20, ladder: [], trailStepR: smc.trendTrailStepR, trailGapR: smc.trendTrailGapR, orderFlowHold: false, orderFlowTf: '15m', orderFlowSignals: ['fvg', 'wick'], orderFlowWickRatio: 0.5 }
}

/** Partial update accepted from the UI; risk fields may be patched individually. */
export const configPatchSchema = appConfigSchema
  .omit({ risk: true, data: true, smc: true, news: true, claude: true, screener: true, bot: true, exit: true, radar: true, notify: true })
  .partial()
  .extend({
    risk: riskConfigSchema.omit({ requireStopLoss: true }).partial().strict().optional(),
    data: dataConfigSchema.partial().strict().optional(),
    smc: smcConfigSchema.partial().strict().optional(),
    news: newsConfigSchema.partial().strict().optional(),
    claude: claudeConfigSchema.partial().strict().optional(),
    screener: screenerConfigSchema.partial().strict().optional(),
    bot: botConfigSchema.omit({ live: true }).partial().strict().optional(),
    exit: exitConfigSchema.partial().strict().optional(),
    radar: radarConfigSchema.partial().strict().optional(),
    notify: notifyConfigSchema.partial().strict().optional()
  })
  .strict()
export type ConfigPatch = z.infer<typeof configPatchSchema>

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Keep only the keys that exist in `raw` (recursively for plain objects). */
function onlyGiven(parsed: unknown, raw: unknown): unknown {
  if (!isPlainObject(parsed) || !isPlainObject(raw)) return parsed
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) if (k in parsed) out[k] = onlyGiven(parsed[k], raw[k])
  return out
}

/**
 * Validate a partial config update. Zod 4 still applies `.default()` inside `.partial()`, so a plain
 * parse of `{ bot: { enabled: true } }` comes back with every other bot field reset to its default
 * (that silently reset riskPerTradePct to 1 on "Start bot"). Only the keys the caller sent are kept.
 */
export function parseConfigPatch(raw: unknown): ConfigPatch {
  return onlyGiven(configPatchSchema.parse(raw), raw) as ConfigPatch
}

/** True if a symbol should be synced/traded according to the data config. */
export function isSymbolAllowed(symbol: string, data: Pick<DataConfig, 'excludeSymbols' | 'excludeNonAscii'>): boolean {
  if (data.excludeSymbols.includes(symbol)) return false
  if (data.excludeNonAscii && !/^[\x20-\x7E]+$/.test(symbol)) return false
  return true
}
