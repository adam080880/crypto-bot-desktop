import { describe, expect, it } from 'vitest'
import { validateOutput } from './validate'

const good = {
  symbol: 'BTCUSDT',
  bias: 'short',
  confidence: 62,
  reasons: ['CPI panas → USD bullish → crypto bearish', 'trend 4h bearish'],
  key_levels: [{ price: 74000, label: 'BSL' }],
  invalidation: { price: 74500, reason: 'close di atas SBR 4h' }
}

describe('Claude output validation (invalid → skip)', () => {
  it('accepts a valid output', () => {
    const v = validateOutput({ analyses: [good], market_note: 'ok' }, ['BTCUSDT'])
    expect(v.valid).toBe(true)
    expect(v.items).toEqual([{ item: good, forcedSkip: false }])
  })

  it('forces skip for invalid items and missing symbols, drops unrequested ones', () => {
    const bad = { ...good, symbol: 'ETHUSDT', bias: 'buy' } // not long/short/skip
    const extra = { ...good, symbol: 'DOGEUSDT' }
    const v = validateOutput({ analyses: [good, bad, extra], market_note: '' }, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
    expect(v.items.map((x) => [x.item.symbol, x.item.bias, x.forcedSkip])).toEqual([
      ['BTCUSDT', 'short', false],
      ['ETHUSDT', 'skip', true],
      ['SOLUSDT', 'skip', true]
    ])
  })

  it('garbage → everything skip', () => {
    const v = validateOutput('lol', ['BTCUSDT'])
    expect(v.valid).toBe(false)
    expect(v.items[0]).toMatchObject({ item: { bias: 'skip' }, forcedSkip: true })
  })
})
