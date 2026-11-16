import { tradeOutcome, type BotTrade } from '@shared/bot'
import type { BotConfig } from '@shared/config'

export interface BlacklistEntry {
  symbol: string
  /** Losing trades (SL, not BE) inside the window. */
  losses: number
  /** New entries allowed again from this time. */
  until: number
}

/**
 * Auto blacklist (user, 2026-11-16): coins with ≥ slBlacklistCount losing trades closed in the last
 * slBlacklistHours. Blocked until the N-th newest of those losses leaves the window.
 */
export function slBlacklist(
  trades: readonly Pick<BotTrade, 'symbol' | 'status' | 'pnl' | 'riskUsd' | 'direction' | 'entry' | 'sl' | 'closedAt'>[],
  bot: Pick<BotConfig, 'slBlacklistCount' | 'slBlacklistHours'>,
  now: number
): Map<string, BlacklistEntry> {
  const out = new Map<string, BlacklistEntry>()
  const n = bot.slBlacklistCount
  if (n <= 0) return out
  const win = bot.slBlacklistHours * 3_600_000
  const bySym = new Map<string, number[]>()
  for (const t of trades) {
    if (t.closedAt === null || t.closedAt <= now - win || tradeOutcome(t) !== 'loss') continue
    const l = bySym.get(t.symbol) ?? []
    l.push(t.closedAt)
    bySym.set(t.symbol, l)
  }
  for (const [symbol, ts] of bySym) {
    if (ts.length < n) continue
    ts.sort((a, b) => b - a)
    out.set(symbol, { symbol, losses: ts.length, until: ts[n - 1]! + win })
  }
  return out
}
