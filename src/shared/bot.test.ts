import { describe, expect, it } from 'vitest'
import { tradeOutcome, type BotTrade } from './bot'

const t = (p: Partial<BotTrade>): Parameters<typeof tradeOutcome>[0] => ({ status: 'closed', pnl: 0, riskUsd: 1, direction: 'bullish', entry: 100, sl: 99, ...p })

describe('tradeOutcome', () => {
  it('BE stop with a small negative PnL is BE, not a loss', () => {
    expect(tradeOutcome(t({ sl: 100.05, pnl: -0.02 }))).toBe('be')
    expect(tradeOutcome(t({ direction: 'bearish', sl: 99.9, pnl: -0.2 }))).toBe('be')
  })
  it('a near-zero result is BE', () => expect(tradeOutcome(t({ pnl: 0.1 }))).toBe('be'))
  it('wins and losses by R', () => {
    expect(tradeOutcome(t({ pnl: 1.5, sl: 101 }))).toBe('win')
    expect(tradeOutcome(t({ pnl: -1.1 }))).toBe('loss')
  })
  it('open trades have no outcome', () => expect(tradeOutcome(t({ status: 'open' }))).toBeNull())
})
