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
  /** §6 Q11: both OCL candles need body ≥ this share of their range. */
  oclMinBodyRatio: z.number().min(0).max(1).default(0.6),
  /** §3 Q7: SL buffer beyond the wick, % of price. */
  slBufferPct: z.number().min(0).max(5).default(0.1),
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

export const appConfigSchema = z.object({
  mode: tradingModeSchema.default('paper'),
  /** ccxt exchange id; Binance USDT-M perpetual by default. */
  exchangeId: z.string().default('binanceusdm'),
  /** Binance symbol ids (e.g. BTCUSDT). Always streamed live. */
  watchlist: z.array(z.string().regex(/^[A-Z0-9]{2,30}$/)).default(['BTCUSDT', 'ETHUSDT']),
  risk: riskConfigSchema.default(riskConfigSchema.parse({})),
  data: dataConfigSchema.default(dataConfigSchema.parse({})),
  smc: smcConfigSchema.default(smcConfigSchema.parse({}))
})

export type RiskConfig = z.infer<typeof riskConfigSchema>
export type AppConfig = z.infer<typeof appConfigSchema>

export const defaultAppConfig: AppConfig = appConfigSchema.parse({})

/** Partial update accepted from the UI; risk fields may be patched individually. */
export const configPatchSchema = appConfigSchema
  .omit({ risk: true, data: true, smc: true })
  .partial()
  .extend({
    risk: riskConfigSchema.omit({ requireStopLoss: true }).partial().strict().optional(),
    data: dataConfigSchema.partial().strict().optional(),
    smc: smcConfigSchema.partial().strict().optional()
  })
  .strict()
export type ConfigPatch = z.infer<typeof configPatchSchema>

/** True if a symbol should be synced/traded according to the data config. */
export function isSymbolAllowed(symbol: string, data: Pick<DataConfig, 'excludeSymbols' | 'excludeNonAscii'>): boolean {
  if (data.excludeSymbols.includes(symbol)) return false
  if (data.excludeNonAscii && !/^[\x20-\x7E]+$/.test(symbol)) return false
  return true
}
