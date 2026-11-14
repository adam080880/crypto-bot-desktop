import type { BotEvent, BotEventLevel, BotTrade } from '@shared/bot'
import type { Db } from '../db/client'
import type { AnalysisLite } from './gate'

/** Bot audit trail: trades (payload = BotTrade JSON) and the decision log. */
/** Rows saved before entry v2 lack the new fields. */
export const normalizeTrade = (t: Partial<BotTrade> & Pick<BotTrade, 'sl'>): BotTrade =>
  ({
    model: 'M0',
    confluence: [],
    slInitial: t.sl,
    closedQty: 0,
    realized: 0,
    partials: 0,
    slSeq: 0,
    exitPlan: null,
    exitState: null,
    ...t
  }) as BotTrade

export class BotRepo {
  constructor(private readonly db: Db) {}

  private get c() {
    return this.db.$client
  }

  save(t: BotTrade): void {
    this.c
      .prepare(
        `INSERT INTO bot_trades (id, setup_id, mode, symbol, status, created_at, closed_at, pnl, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, closed_at = excluded.closed_at,
           pnl = excluded.pnl, payload = excluded.payload`
      )
      .run(t.id, t.setupId, t.mode, t.symbol, t.status, t.createdAt, t.closedAt, t.pnl, JSON.stringify(t))
  }

  active(): BotTrade[] {
    return (this.c.prepare(`SELECT payload FROM bot_trades WHERE status IN ('pending', 'open') ORDER BY created_at`).pluck().all() as string[]).map(
      (p) => normalizeTrade(JSON.parse(p))
    )
  }

  recent(limit = 100): BotTrade[] {
    return (this.c.prepare(`SELECT payload FROM bot_trades ORDER BY created_at DESC LIMIT ?`).pluck().all(limit) as string[]).map(
      (p) => normalizeTrade(JSON.parse(p))
    )
  }

  /** Setups already acted on in this mode (never enter the same setup twice). */
  hasSetup(setupId: string, mode: string): boolean {
    return !!this.c.prepare(`SELECT 1 FROM bot_trades WHERE setup_id = ? AND mode = ? LIMIT 1`).get(setupId, mode)
  }

  pnlSince(mode: string, t: number): number {
    return (this.c.prepare(`SELECT coalesce(sum(pnl), 0) FROM bot_trades WHERE mode = ? AND status = 'closed' AND closed_at >= ?`).pluck().get(mode, t) as number) ?? 0
  }

  log(level: BotEventLevel, symbol: string | null, message: string): BotEvent {
    const t = Date.now()
    const r = this.c.prepare(`INSERT INTO bot_events (t, level, symbol, message) VALUES (?, ?, ?, ?)`).run(t, level, symbol, message.slice(0, 500))
    return { id: Number(r.lastInsertRowid), t, level, symbol, message }
  }

  events(limit = 200): BotEvent[] {
    return this.c.prepare(`SELECT id, t, level, symbol, message FROM bot_events ORDER BY id DESC LIMIT ?`).all(limit) as BotEvent[]
  }

  /** Newest Claude analysis for a symbol. */
  latestAnalysis(symbol: string): AnalysisLite | null {
    const r = this.c
      .prepare(`SELECT id, created_at AS createdAt, bias, confidence, forced_skip AS forcedSkip FROM claude_analyses WHERE symbol = ? ORDER BY created_at DESC LIMIT 1`)
      .get(symbol) as { id: string; createdAt: number; bias: AnalysisLite['bias']; confidence: number; forcedSkip: number } | undefined
    return r ? { ...r, forcedSkip: !!r.forcedSkip } : null
  }
}
