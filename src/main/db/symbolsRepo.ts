import { and, eq, inArray } from 'drizzle-orm'
import type { Timeframe } from '@shared/timeframes'
import type { Db } from './client'
import { symbols, syncState } from './schema'

export interface SymbolInfo {
  symbol: string
  baseAsset: string
  quoteAsset: string
  onboardDate: number
  status: string
}

export type SymbolRow = typeof symbols.$inferSelect

/**
 * Upsert the active symbol list. Symbols no longer listed are marked inactive (never deleted,
 * so their ids stay stable). Returns the symbols that were newly inserted.
 */
export function upsertSymbols(db: Db, list: readonly SymbolInfo[]): SymbolRow[] {
  const now = Date.now()
  const existing = new Set(db.select({ s: symbols.symbol }).from(symbols).all().map((r) => r.s))
  db.transaction((tx) => {
    tx.update(symbols).set({ isActive: false, updatedAt: now }).run()
    for (const s of list) {
      tx.insert(symbols)
        .values({ ...s, isActive: true, updatedAt: now })
        .onConflictDoUpdate({
          target: symbols.symbol,
          set: { status: s.status, onboardDate: s.onboardDate, isActive: true, updatedAt: now }
        })
        .run()
    }
  })
  const fresh = list.filter((s) => !existing.has(s.symbol)).map((s) => s.symbol)
  return fresh.length ? db.select().from(symbols).where(inArray(symbols.symbol, fresh)).all() : []
}

export function activeSymbols(db: Db): SymbolRow[] {
  return db.select().from(symbols).where(eq(symbols.isActive, true)).orderBy(symbols.symbol).all()
}

export function symbolByName(db: Db, symbol: string): SymbolRow | undefined {
  return db.select().from(symbols).where(eq(symbols.symbol, symbol)).get()
}

export function getSyncState(db: Db, symbolId: number, tf: Timeframe) {
  return db
    .select()
    .from(syncState)
    .where(and(eq(syncState.symbolId, symbolId), eq(syncState.timeframe, tf)))
    .get()
}

/** Record newest stored candle (monotonic: never moves backwards). */
export function markSynced(db: Db, symbolId: number, tf: Timeframe, first: number, last: number): void {
  const now = Date.now()
  const cur = getSyncState(db, symbolId, tf)
  db.insert(syncState)
    .values({ symbolId, timeframe: tf, firstOpenTime: first, lastOpenTime: last, updatedAt: now })
    .onConflictDoUpdate({
      target: [syncState.symbolId, syncState.timeframe],
      set: {
        firstOpenTime: Math.min(cur?.firstOpenTime ?? first, first),
        lastOpenTime: Math.max(cur?.lastOpenTime ?? last, last),
        updatedAt: now
      }
    })
    .run()
}

export function allSyncStates(db: Db) {
  return db.select().from(syncState).all()
}
