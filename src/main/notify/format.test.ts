import { describe, expect, it } from 'vitest'
import type { BotEvent } from '@shared/bot'
import { botMessages, isDiscordWebhook, pickBotEvents, radarMessage } from './format'

const ev = (id: number, level: BotEvent['level'], message = 'x'): BotEvent => ({ id, t: 0, level, symbol: 'BTCUSDT', message })

describe('discord format', () => {
  it('accepts only Discord webhook URLs', () => {
    expect(isDiscordWebhook('https://discord.com/api/webhooks/123/abc_DEF-1')).toBe(true)
    expect(isDiscordWebhook('https://canary.discord.com/api/webhooks/123/abc')).toBe(true)
    expect(isDiscordWebhook('https://evil.com/api/webhooks/123/abc')).toBe(false)
    expect(isDiscordWebhook('http://discord.com/api/webhooks/123/abc')).toBe(false)
  })
  it('picks new order / warning events by config, oldest first', () => {
    const list = [ev(5, 'skip'), ev(4, 'error'), ev(3, 'order'), ev(2, 'info'), ev(1, 'order')]
    expect(pickBotEvents(list, 1, { botOrders: true, botWarnings: true }).map((e) => e.id)).toEqual([3, 4])
    expect(pickBotEvents(list, 0, { botOrders: false, botWarnings: true }).map((e) => e.id)).toEqual([4])
  })
  it('splits long event lists at 2000 characters', () => {
    const msgs = botMessages(Array.from({ length: 30 }, (_, i) => ev(i, 'order', 'y'.repeat(150))))
    expect(msgs.length).toBeGreaterThan(1)
    for (const m of msgs) expect(m.content!.length).toBeLessThanOrEqual(2000)
  })
  it('radar: at most 10 embeds', () => {
    const hits = Array.from({ length: 12 }, (_, i) => ({ symbol: `C${i}USDT`, t: 0, reasons: ['vol' as const], volRatio: 3 + i, funding: null, ret24: 0.1, price: 1 }))
    const m = radarMessage(hits)
    expect(m.embeds).toHaveLength(10)
    expect(m.content).toContain('12 koin')
  })
})
