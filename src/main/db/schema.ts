import { blob, index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Generic key/value app settings (JSON-encoded values, validated with zod on read). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/** Secrets encrypted with Electron safeStorage. Plaintext never touches disk. */
export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
  updatedAt: integer('updated_at').notNull()
})

/** Binance USDT-M perpetual symbols. Integer id keeps candle PKs small. */
export const symbols = sqliteTable('symbols', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  symbol: text('symbol').notNull().unique(),
  baseAsset: text('base_asset').notNull(),
  quoteAsset: text('quote_asset').notNull(),
  onboardDate: integer('onboard_date').notNull(),
  status: text('status').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull(),
  updatedAt: integer('updated_at').notNull()
})

/**
 * Sync progress per symbol + timeframe. `lastOpenTime` = open time of the newest stored
 * (closed) candle; backfill resumes from lastOpenTime + timeframe.
 */
export const syncState = sqliteTable(
  'sync_state',
  {
    symbolId: integer('symbol_id').notNull(),
    timeframe: text('timeframe').notNull(),
    firstOpenTime: integer('first_open_time'),
    lastOpenTime: integer('last_open_time'),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.symbolId, t.timeframe] })]
)

// Candle tables (candles_1m … candles_1w) are created in a hand-written migration because
// they use WITHOUT ROWID, which drizzle-kit can't express. Accessed via src/main/db/candles.ts.

/** Economic calendar events (Fase 5). Title/raw strings come from an external feed: data only. */
export const economicEvents = sqliteTable(
  'economic_events',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    title: text('title').notNull(),
    currency: text('currency').notNull(),
    impact: text('impact').notNull(),
    time: integer('time').notNull(),
    forecastRaw: text('forecast_raw'),
    previousRaw: text('previous_raw'),
    actualRaw: text('actual_raw'),
    forecast: real('forecast'),
    previous: real('previous'),
    actual: real('actual'),
    actualSource: text('actual_source'),
    actualAt: integer('actual_at'),
    ruleKey: text('rule_key'),
    usdBias: text('usd_bias'),
    cryptoBias: text('crypto_bias'),
    biasReason: text('bias_reason'),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [index('economic_events_time_idx').on(t.time)]
)

/** Price reaction N minutes after an event, to evaluate "bad for USD = good for crypto". */
export const eventReactions = sqliteTable(
  'event_reactions',
  {
    eventId: text('event_id').notNull(),
    symbol: text('symbol').notNull(),
    horizonMin: integer('horizon_min').notNull(),
    priceBefore: real('price_before').notNull(),
    priceAfter: real('price_after').notNull(),
    changePct: real('change_pct').notNull(),
    computedAt: integer('computed_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.eventId, t.symbol, t.horizonMin] })]
)

/** Trade-on-news candidates (never orders). Payload = NewsCandidate JSON. */
export const newsCandidates = sqliteTable(
  'news_candidates',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').notNull(),
    symbol: text('symbol').notNull(),
    createdAt: integer('created_at').notNull(),
    payload: text('payload').notNull()
  },
  (t) => [index('news_candidates_created_idx').on(t.createdAt)]
)

/** Fase 6: one row per Claude analysis run (trigger, cost, status). */
export const claudeRuns = sqliteTable(
  'claude_runs',
  {
    id: text('id').primaryKey(),
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
    trigger: text('trigger').notNull(),
    eventTitles: text('event_titles').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    costUsd: real('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    marketNote: text('market_note')
  },
  (t) => [index('claude_runs_created_idx').on(t.createdAt)]
)

/** Fase 6: validated per-symbol output. Payload = AnalysisItem JSON. */
export const claudeAnalyses = sqliteTable(
  'claude_analyses',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    createdAt: integer('created_at').notNull(),
    symbol: text('symbol').notNull(),
    bias: text('bias').notNull(),
    confidence: real('confidence').notNull(),
    price: real('price'),
    forcedSkip: integer('forced_skip', { mode: 'boolean' }).notNull(),
    payload: text('payload').notNull()
  },
  (t) => [index('claude_analyses_symbol_idx').on(t.symbol, t.createdAt)]
)

/** Fase 7: one row per bot trade (paper or live). Payload = BotTrade JSON (audit trail). */
export const botTrades = sqliteTable(
  'bot_trades',
  {
    id: text('id').primaryKey(),
    setupId: text('setup_id').notNull(),
    mode: text('mode').notNull(),
    symbol: text('symbol').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
    closedAt: integer('closed_at'),
    pnl: real('pnl'),
    payload: text('payload').notNull()
  },
  (t) => [index('bot_trades_setup_idx').on(t.setupId, t.mode), index('bot_trades_status_idx').on(t.status, t.createdAt)]
)

/** Fase 7: bot decision log (why a setup was taken or skipped, every order sent). */
export const botEvents = sqliteTable(
  'bot_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    t: integer('t').notNull(),
    level: text('level').notNull(),
    symbol: text('symbol'),
    message: text('message').notNull()
  },
  (t) => [index('bot_events_t_idx').on(t.t)]
)
