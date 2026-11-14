import type { Db } from '../db/client'
import type { FlowData } from '../strategy/flow'

const DAY = 86_400_000
/** Live needs at most 24h + 4h of OI (docs/entry-v2.md §10, user: "simpan 3 hari aja"). */
export const OI_RETENTION_DAYS = 3
/** Funding percentile window = 90 settlements ≈ 30 days at 8h. */
export const FUNDING_RETENTION_DAYS = 35

/** Open interest / funding rows (tables from drizzle/0006_flow.sql). */
export class FlowRepo {
  constructor(private readonly db: Db) {}

  saveOi(symbolId: number, rows: readonly { t: number; v: number }[]): void {
    const st = this.db.$client.prepare('INSERT OR REPLACE INTO flow_oi (symbol_id, t, value) VALUES (?, ?, ?)')
    this.db.$client.transaction(() => {
      for (const r of rows) st.run(symbolId, r.t, r.v)
    })()
  }

  saveFunding(symbolId: number, rows: readonly { t: number; r: number }[]): void {
    const st = this.db.$client.prepare('INSERT OR REPLACE INTO flow_funding (symbol_id, t, rate) VALUES (?, ?, ?)')
    this.db.$client.transaction(() => {
      for (const r of rows) st.run(symbolId, r.t, r.r)
    })()
  }

  /** Everything stored for a symbol, oldest first. */
  get(symbolId: number): FlowData {
    const oi = this.db.$client.prepare('SELECT t, value AS v FROM flow_oi WHERE symbol_id = ? ORDER BY t').all(symbolId) as { t: number; v: number }[]
    const funding = this.db.$client.prepare('SELECT t, rate AS r FROM flow_funding WHERE symbol_id = ? ORDER BY t').all(symbolId) as { t: number; r: number }[]
    return { oi, funding }
  }

  lastOiT(symbolId: number): number | null {
    return (this.db.$client.prepare('SELECT max(t) FROM flow_oi WHERE symbol_id = ?').pluck().get(symbolId) as number | null) ?? null
  }

  fundingCount(symbolId: number): number {
    return this.db.$client.prepare('SELECT count(*) FROM flow_funding WHERE symbol_id = ?').pluck().get(symbolId) as number
  }

  prune(now = Date.now()): { oi: number; funding: number } {
    const oi = this.db.$client.prepare('DELETE FROM flow_oi WHERE t < ?').run(now - OI_RETENTION_DAYS * DAY).changes
    const funding = this.db.$client.prepare('DELETE FROM flow_funding WHERE t < ?').run(now - FUNDING_RETENTION_DAYS * DAY).changes
    return { oi, funding }
  }
}
