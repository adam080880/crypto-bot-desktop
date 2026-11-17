import type { BotEvent } from '@shared/bot'
import type { NotifyConfig } from '@shared/config'
import type { RadarHit } from '@shared/radar'
import type { ScreenerRow } from '@shared/screener'

/** Discord webhook message (subset). Content ≤ 2000 chars, ≤ 10 embeds. */
export interface DiscordMessage {
  content?: string
  embeds?: DiscordEmbed[]
}

export interface DiscordEmbed {
  title: string
  url?: string
  description?: string
  color?: number
  fields?: { name: string; value: string; inline?: boolean }[]
  footer?: { text: string }
  timestamp?: string
}

const GREEN = 0x16a34a
const RED = 0xdc2626
const MAX_CONTENT = 2000

export const isDiscordWebhook = (url: string): boolean => /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url)

const pct = (x: number, d = 1): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`
const price = (x: number): string => (x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4))
const futuresUrl = (symbol: string): string => `https://www.binance.com/en/futures/${symbol}`

/** Pump radar hits → one message (max 10 embeds, the strongest first). */
export function radarMessage(hits: readonly RadarHit[]): DiscordMessage {
  const shown = hits.slice(0, 10)
  return {
    content: `📡 **Radar pump**: ${hits.length} koin${hits.length > shown.length ? ` (${shown.length} teratas)` : ''}. Notifikasi saja, bot tidak entry.`,
    embeds: shown.map((h) => ({
      title: `${h.ret24 >= 0 ? '🚀' : '🩸'} ${h.symbol}`,
      url: futuresUrl(h.symbol),
      color: h.ret24 >= 0 ? GREEN : RED,
      fields: [
        { name: 'Volume 24j', value: `${h.volRatio.toFixed(1)}× median`, inline: true },
        { name: 'Funding', value: h.funding === null ? '—' : pct(h.funding, 3), inline: true },
        { name: '24j', value: pct(h.ret24), inline: true },
        { name: 'Harga', value: price(h.price), inline: true },
        { name: 'Pemicu', value: h.reasons.map((r) => (r === 'vol' ? 'volume meledak' : 'funding negatif + volume')).join(' · '), inline: true }
      ],
      timestamp: new Date(h.t + 3_600_000).toISOString()
    }))
  }
}

const EMOJI: Partial<Record<BotEvent['level'], string>> = { order: '📥', warn: '⚠️', error: '⛔' }

/** Bot events worth a ping (by config), oldest first. */
export function pickBotEvents(events: readonly BotEvent[], afterId: number, cfg: Pick<NotifyConfig, 'botOrders' | 'botWarnings'>): BotEvent[] {
  return events
    .filter((e) => e.id > afterId && ((e.level === 'order' && cfg.botOrders) || ((e.level === 'warn' || e.level === 'error') && cfg.botWarnings)))
    .sort((a, b) => a.id - b.id)
}

/** Bot events → messages of at most 2000 characters. */
export function botMessages(events: readonly BotEvent[]): DiscordMessage[] {
  const out: DiscordMessage[] = []
  let cur = ''
  for (const e of events) {
    let line = `${EMOJI[e.level] ?? '•'} ${e.symbol ? `**${e.symbol}** ` : ''}${e.message}`
    if (line.length > MAX_CONTENT) line = line.slice(0, MAX_CONTENT - 1) + '…'
    if (cur && cur.length + 1 + line.length > MAX_CONTENT) {
      out.push({ content: cur })
      cur = ''
    }
    cur = cur ? `${cur}\n${line}` : line
  }
  if (cur) out.push({ content: cur })
  return out
}

/** New screener setups (automatic scan): entry / SL / TP with the TP in R and the 1R price. */
export function screenerMessage(rows: readonly ScreenerRow[]): DiscordMessage {
  const lines = rows.slice(0, 15).map((r) => {
    const s = r.setup!
    const bull = r.direction === 'bullish'
    const risk = Math.abs(s.entry - s.sl)
    const trail = s.model === 'M5' || s.model === 'M6'
    const oneR = bull ? s.entry + risk : s.entry - risk
    const tp = trail ? 'TP trailing' : `TP ${price(s.tp)} (+${s.rr}R)`
    return `• **${r.symbol}** ${bull ? 'LONG' : 'SHORT'} · ${s.model} · limit ${price(s.entry)} · SL ${price(s.sl)} (−1R, ${((risk / s.entry) * 100).toFixed(2)}%) · ${tp} · 1R @${price(oneR)} · skor ${s.score}`
  })
  return { content: `🔎 **Screener**: ${rows.length} setup baru\n${lines.join('\n')}${rows.length > 15 ? `\n+${rows.length - 15} lagi` : ''}` }
}
