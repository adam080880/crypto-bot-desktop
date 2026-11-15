import type { NotifyConfig } from '@shared/config'
import { logger } from '../logger'
import { isDiscordWebhook, type DiscordMessage } from './format'

const log = logger('discord')
const GAP_MS = 1100 // webhooks allow ~5 requests / 2 s and 30 / minute per channel

/**
 * Sends messages to the stored Discord webhook (main process: the URL is a safeStorage secret and is
 * never logged). One request at a time, ~1 s apart, honours 429 retry_after (once). Fire-and-forget:
 * a failed message is logged and dropped, notifications never block trading.
 */
export class DiscordNotifier {
  private queue: Promise<unknown> = Promise.resolve()
  private lastAt = 0

  constructor(
    private readonly getUrl: () => string | null,
    private readonly getConfig: () => NotifyConfig
  ) {}

  /** Queue a message when Discord notifications are on and a webhook is stored. */
  notify(msg: DiscordMessage): void {
    if (!this.getConfig().discord || !this.getUrl()) return
    void this.send(msg)
  }

  send(msg: DiscordMessage): Promise<{ ok: boolean; error?: string }> {
    const run = this.queue.then(() => this.post(msg))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async post(msg: DiscordMessage, retried = false): Promise<{ ok: boolean; error?: string }> {
    const url = this.getUrl()
    if (!url) return { ok: false, error: 'Webhook Discord belum disimpan' }
    if (!isDiscordWebhook(url)) return { ok: false, error: 'URL webhook tidak valid' }
    const wait = this.lastAt + GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastAt = Date.now()
    try {
      const res = await fetch(`${url}?wait=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'SMC Assistant', allowed_mentions: { parse: [] }, ...msg }),
        signal: AbortSignal.timeout(10_000)
      })
      if (res.status === 429 && !retried) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number }
        await new Promise((r) => setTimeout(r, Math.min(30, body.retry_after ?? 2) * 1000))
        return this.post(msg, true)
      }
      if (!res.ok) {
        const error = `Discord HTTP ${res.status}`
        log.warn({ status: res.status }, 'discord webhook failed')
        return { ok: false, error }
      }
      return { ok: true }
    } catch (err) {
      log.warn({ err: (err as Error).name }, 'discord webhook error')
      return { ok: false, error: (err as Error).message }
    }
  }
}
