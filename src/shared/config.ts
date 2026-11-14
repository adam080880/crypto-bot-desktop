import { z } from 'zod'

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
  models: z.array(z.enum(['M0', 'M1', 'M2a', 'M2b', 'M4'])).default(['M0', 'M1', 'M2a', 'M2b', 'M4']),
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
  /** Plain OCL may be a parent (reason) only from these timeframes ("OC dari high timeframe"). */
  oclParentTimeframes: z.array(z.enum(['1h', '4h', '1d', '1w'])).default(['4h', '1d', '1w']),
  /** Wyckoff range: N candles whose range ≤ wyRangeAtr × ATR (ATR measured before the range). */
  wyRangeCandles: z.number().int().min(5).max(200).default(24),
  wyRangeAtr: z.number().min(1).max(30).default(4),
  wyckoffTimeframes: z.array(z.enum(['15m', '1h', '4h', '1d'])).default(['4h', '1h'])
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
  orderFlowWickRatio: z.number().min(0.3).max(0.95).default(0.5)
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
export const botConfigSchema = z.object({
  /** Bot running (paper unless `live`). */
  enabled: z.boolean().default(false),
  /** Require a fresh Claude analysis (bias + confidence) before entering. Off = pure ICT/SMC math (user). */
  requireClaude: z.boolean().default(false),
  /** Entry models the bot may trade (docs/entry-v2.md). M0/M2a lost money in the 2-year backtest. */
  models: z.array(z.enum(['M0', 'M1', 'M2a', 'M2b', 'M4'])).min(1).default(['M1', 'M2b', 'M4']),
  /** Every one of these confluences must be present (backtest: FVG in the leg + trend of the POI TF). */
  requireConfluence: z
    .array(z.enum(['fvg', 'sweep', 'equalLiq', 'displacement', 'htfParent', 'trendParent', 'btc4h', 'btc1h', 'wyckoff', 'manipulation', 'unicorn', 'prevOpposite']))
    .default(['fvg', 'trendParent']),
  minScore: z.number().int().min(0).max(20).default(0),
  /** Real orders on Binance USDT-M. Off by default; switched on only via `bot:setLive` + confirmation. */
  live: z.boolean().default(false),
  minConfidence: z.number().int().min(0).max(100).default(70),
  /**
   * Risk-based sizing: max loss per order if the SL is hit, % of equity.
   * Size = equity × riskPerTradePct ÷ |entry − SL| distance (capped by risk.maxLeverage).
   */
  riskPerTradePct: z.number().positive().max(100).default(1),
  /** Only the N most traded crypto perpetuals (24h quote volume); no TradFi/commodities/indices. */
  topVolume: z.number().int().min(5).max(300).default(100),
  /** M1/M2b: the parent POI (the reason) must come from these timeframes. M4 breakers are not limited. */
  poiTimeframes: z.array(z.enum(['15m', '1h', '4h', '1d'])).min(1).default(['1h', '4h', '1d']),
  /** Only take setups confirmed within the last N minutes (no chasing old ones). */
  maxSetupAgeMin: z.number().int().min(1).max(525600).default(60),
  /** (requireClaude) The Claude analysis must be newer than the setup and at most this old. */
  maxAnalysisAgeMin: z.number().int().min(1).max(525600).default(90),
  /** Paper account starting balance (USDT). */
  paperEquity: z.number().positive().max(1e9).default(10)
})
export type BotConfig = z.infer<typeof botConfigSchema>

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
  exit: exitConfigSchema.default(exitConfigSchema.parse({}))
})

export type RiskConfig = z.infer<typeof riskConfigSchema>
export type AppConfig = z.infer<typeof appConfigSchema>

export const defaultAppConfig: AppConfig = appConfigSchema.parse({})

/** Partial update accepted from the UI; risk fields may be patched individually. */
export const configPatchSchema = appConfigSchema
  .omit({ risk: true, data: true, smc: true, news: true, claude: true, screener: true, bot: true, exit: true })
  .partial()
  .extend({
    risk: riskConfigSchema.omit({ requireStopLoss: true }).partial().strict().optional(),
    data: dataConfigSchema.partial().strict().optional(),
    smc: smcConfigSchema.partial().strict().optional(),
    news: newsConfigSchema.partial().strict().optional(),
    claude: claudeConfigSchema.partial().strict().optional(),
    screener: screenerConfigSchema.partial().strict().optional(),
    bot: botConfigSchema.omit({ live: true }).partial().strict().optional(),
    exit: exitConfigSchema.partial().strict().optional()
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
