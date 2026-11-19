import { describe, expect, it } from 'vitest'
import { slBlacklist } from './blacklist'

const H = 3_600_000
const now = 1000 * H
const t = (symbol: string, r: number, hoursAgo: number, stopAtBe = false) => ({
  symbol,
  status: 'closed' as const,
  pnl: r,
  riskUsd: 1,
  direction: 'bullish' as const,
  entry: 100,
  sl: stopAtBe ? 100 : 99,
  closedAt: now - hoursAgo * H
})

describe('SL blacklist', () => {
  const bot = { slBlacklistCount: 3, slBlacklistHours: 168 }
  it('blocks a coin after N losses in the window until the N-th newest leaves it', () => {
    const m = slBlacklist([t('X', -1, 10), t('X', -1, 50), t('X', -1.1, 100), t('Y', -1, 5), t('Y', -1, 6)], bot, now)
    expect([...m.keys()]).toEqual(['X'])
    expect(m.get('X')).toEqual({ symbol: 'X', losses: 3, until: now - 100 * H + 168 * H })
  })
  it('ignores BE, wins and losses outside the window; 0 = off', () => {
    const tr = [t('X', -1, 10), t('X', -0.05, 20, true), t('X', 2, 30), t('X', -1, 200), t('X', -1, 40)]
    expect(slBlacklist(tr, bot, now).size).toBe(0)
    expect(slBlacklist([t('X', -1, 1), t('X', -1, 2), t('X', -1, 3)], { ...bot, slBlacklistCount: 0 }, now).size).toBe(0)
  })
})

describe('modelStats', () => {
  it('counts win / BE / loss and R per model', async () => {
    const { modelStats } = await import('@shared/bot')
    const base = { status: 'closed', riskUsd: 1, direction: 'bullish', entry: 100, sl: 99 } as const
    const s = modelStats([
      { ...base, model: 'M1', pnl: 2 },
      { ...base, model: 'M1', pnl: -1 },
      { ...base, model: 'M1', pnl: 0.05 },
      { ...base, model: 'M2a', pnl: -1 },
      { ...base, model: 'M2a', status: 'cancelled', pnl: null }
    ] as never)
    expect(s.find((m) => m.model === 'M1')).toMatchObject({ trades: 3, wins: 1, bes: 1, losses: 1, wr: 0.5 })
    expect(s.find((m) => m.model === 'M1')!.totalR).toBeCloseTo(1.05)
    expect(s.find((m) => m.model === 'M2a')).toMatchObject({ trades: 1, losses: 1, wr: 0 })
  })
  it('total stats with the max drawdown of the cumulative R in close order', async () => {
    const { tradeStats } = await import('@shared/bot')
    const base = { status: 'closed', riskUsd: 1, direction: 'bullish', entry: 100, sl: 99, model: 'M0' } as const
    const s = tradeStats([
      { ...base, pnl: -1, closedAt: 2 },
      { ...base, pnl: 2, closedAt: 1 },
      { ...base, pnl: -1, closedAt: 3 },
      { ...base, pnl: 3, closedAt: 4 }
    ] as never)
    expect(s).toMatchObject({ trades: 4, wins: 2, losses: 2 })
    expect(s!.totalR).toBeCloseTo(3)
    expect(s!.maxDdR).toBeCloseTo(2)
    expect(tradeStats([])).toBeNull()
  })
})
