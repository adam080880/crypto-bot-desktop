import { z } from 'zod'

/**
 * Risk guard config. The limits are enforced in code (src/main/risk), never via prompts.
 * Values are configurable, but the guard itself cannot be disabled.
 */
export const riskConfigSchema = z.object({
  /** Max notional per position, as % of account equity. */
  maxPositionPct: z.number().positive().max(100).default(2),
  /** Max realised+unrealised loss per UTC day, % of equity. Breach → bot halts automatically. */
  maxDailyLossPct: z.number().positive().max(100).default(3),
  /** Max simultaneously open positions. */
  maxOpenPositions: z.number().int().positive().max(50).default(3),
  /** Every order must carry a stop-loss. Not configurable on purpose. */
  requireStopLoss: z.literal(true).default(true),
  /** Max leverage allowed. */
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
  poiTimeframes: z.array(z.enum(['5m', '15m', '1h', '4h', '1d'])).default(['4h', '1h']),
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
  equalPct: z.number().min(0).max(2).default(0.1)
})
export type SmcConfig = z.infer<typeof smcConfigSchema>

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

export const appConfigSchema = z.object({
  mode: tradingModeSchema.default('paper'),
  /** ccxt exchange id; Binance USDT-M perpetual by default. */
  exchangeId: z.string().default('binanceusdm'),
  /** Binance symbol ids (e.g. BTCUSDT). Always streamed live. */
  watchlist: z.array(z.string().regex(/^[A-Z0-9]{2,30}$/)).default(['BTCUSDT', 'ETHUSDT']),
  risk: riskConfigSchema.default(riskConfigSchema.parse({})),
  data: dataConfigSchema.default(dataConfigSchema.parse({})),
  smc: smcConfigSchema.default(smcConfigSchema.parse({})),
  news: newsConfigSchema.default(newsConfigSchema.parse({}))
})

export type RiskConfig = z.infer<typeof riskConfigSchema>
export type AppConfig = z.infer<typeof appConfigSchema>

export const defaultAppConfig: AppConfig = appConfigSchema.parse({})

/** Partial update accepted from the UI; risk fields may be patched individually. */
export const configPatchSchema = appConfigSchema
  .omit({ risk: true, data: true, smc: true, news: true })
  .partial()
  .extend({
    risk: riskConfigSchema.omit({ requireStopLoss: true }).partial().strict().optional(),
    data: dataConfigSchema.partial().strict().optional(),
    smc: smcConfigSchema.partial().strict().optional(),
    news: newsConfigSchema.partial().strict().optional()
  })
  .strict()
export type ConfigPatch = z.infer<typeof configPatchSchema>

/** True if a symbol should be synced/traded according to the data config. */
export function isSymbolAllowed(symbol: string, data: Pick<DataConfig, 'excludeSymbols' | 'excludeNonAscii'>): boolean {
  if (data.excludeSymbols.includes(symbol)) return false
  if (data.excludeNonAscii && !/^[\x20-\x7E]+$/.test(symbol)) return false
  return true
}
