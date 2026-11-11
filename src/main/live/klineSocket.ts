import type { Candle } from '@shared/candles'
import { logger } from '../logger'

const log = logger('ws')
/** Kline streams live on the routed /market endpoint; unrouted URLs silently get no kline data. */
export const MARKET_WS = 'wss://fstream.binance.com/market/stream'
const MAX_OUTGOING_PER_SEC = 4 // Binance allows 10 incoming msgs/s per connection
const PARAMS_PER_MESSAGE = 100

export interface KlineMessage {
  symbol: string
  eventTime: number
  candle: Candle
  closed: boolean
}

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'closed'

type Events = {
  kline: (k: KlineMessage) => void
  /** Fired after a *re*connect (not the first connect) with the symbols on that connection. */
  reconnected: (symbols: string[]) => void
  state: () => void
}

const streamOf = (symbol: string): string => `${symbol.toLowerCase()}@kline_1m`

/** Split symbols into fixed-size groups, keeping existing assignments stable. */
export function partition(
  wanted: readonly string[],
  current: readonly (readonly string[])[],
  perConn: number
): string[][] {
  const want = new Set(wanted)
  const groups = current.map((g) => g.filter((s) => want.has(s)))
  const placed = new Set(groups.flat())
  for (const s of wanted) {
    if (placed.has(s)) continue
    let g = groups.find((x) => x.length < perConn)
    if (!g) {
      g = []
      groups.push(g)
    }
    g.push(s)
    placed.add(s)
  }
  return groups
}

/** One WebSocket connection carrying up to `perConn` kline streams. */
class KlineConnection {
  readonly symbols = new Set<string>()
  state: ConnState = 'connecting'
  lastMessageAt = 0
  maxLatencyMs = 0
  private ws: WebSocket | null = null
  private attempt = 0
  private everOpened = false
  private disposed = false
  private outbox: string[] = []
  private outTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  /** Symbols baked into the URL of the current socket. */
  private urlSymbols = new Set<string>()

  constructor(
    private readonly id: number,
    private readonly ev: Events
  ) {}

  setSymbols(next: readonly string[]): void {
    const add = next.filter((s) => !this.symbols.has(s))
    const remove = [...this.symbols].filter((s) => !next.includes(s))
    for (const s of add) this.symbols.add(s)
    for (const s of remove) this.symbols.delete(s)
    if (!this.ws) return this.connect()
    if (this.ws.readyState !== WebSocket.OPEN) return // full list is sent on open
    this.queue('UNSUBSCRIBE', remove)
    this.queue('SUBSCRIBE', add)
  }

  private queue(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', symbols: string[]): void {
    for (let i = 0; i < symbols.length; i += PARAMS_PER_MESSAGE) {
      this.outbox.push(
        JSON.stringify({ method, params: symbols.slice(i, i + PARAMS_PER_MESSAGE).map(streamOf), id: this.nextId++ })
      )
    }
    this.outTimer ??= setInterval(() => {
      const msg = this.outbox.shift()
      if (msg && this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg)
      if (!this.outbox.length && this.outTimer) {
        clearInterval(this.outTimer)
        this.outTimer = null
      }
    }, 1000 / MAX_OUTGOING_PER_SEC)
  }

  private connect(): void {
    if (this.disposed || !this.symbols.size) return
    this.urlSymbols = new Set([...this.symbols].slice(0, 50))
    const ws = new WebSocket(`${MARKET_WS}?streams=${[...this.urlSymbols].map(streamOf).join('/')}`)
    this.ws = ws
    this.state = this.everOpened ? 'reconnecting' : 'connecting'
    this.ev.state()

    ws.onopen = () => {
      const isReconnect = this.everOpened
      this.everOpened = true
      this.attempt = 0
      this.state = 'open'
      this.lastMessageAt = Date.now()
      this.outbox = []
      // reconcile with changes made while connecting
      const add = [...this.symbols].filter((x) => !this.urlSymbols.has(x))
      const remove = [...this.urlSymbols].filter((x) => !this.symbols.has(x))
      if (remove.length) this.queue('UNSUBSCRIBE', remove)
      if (add.length) this.queue('SUBSCRIBE', add)
      log.info({ conn: this.id, streams: this.symbols.size, isReconnect }, 'ws open')
      this.ev.state()
      if (isReconnect) this.ev.reconnected([...this.symbols])
    }
    ws.onmessage = (m) => {
      this.lastMessageAt = Date.now()
      let msg: { stream?: string; data?: { e?: string; E?: number; s?: string; k?: Record<string, unknown> } }
      try {
        msg = JSON.parse(String(m.data))
      } catch {
        return
      }
      const d = msg.data
      if (!d || d.e !== 'kline' || !d.k || !d.s) return
      const k = d.k as { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean }
      if (!this.symbols.has(d.s)) return
      const eventTime = d.E ?? Date.now()
      this.maxLatencyMs = Math.max(this.maxLatencyMs * 0.9, Date.now() - eventTime)
      this.ev.kline({
        symbol: d.s,
        eventTime,
        closed: k.x,
        candle: { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }
      })
    }
    ws.onerror = () => {
      /* onclose follows; handled there */
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.disposed) {
        this.state = 'closed'
        this.ev.state()
        return
      }
      const delay = Math.min(60_000, 1000 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5)
      log.warn({ conn: this.id, code: e.code, reason: e.reason, delay: Math.round(delay) }, 'ws closed; reconnecting')
      this.state = 'reconnecting'
      this.ev.state()
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    }
  }

  /** Force a reconnect (watchdog, 24h rotation). */
  recycle(): void {
    if (this.ws) this.ws.close(4000, 'recycle')
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.outTimer) clearInterval(this.outTimer)
    this.ws?.close(1000, 'dispose')
    this.ws = null
    this.state = 'closed'
  }
}

/**
 * Pool of combined-stream connections for 1m klines. Splits symbols across connections
 * (`perConn` streams each), reconnects with exponential backoff, and recycles connections
 * that go silent or approach Binance's 24h limit.
 */
export class KlineSocketPool {
  private conns: KlineConnection[] = []
  private nextConnId = 1
  private watchdog: ReturnType<typeof setInterval>
  private openedAt = new WeakMap<KlineConnection, number>()

  constructor(
    private readonly ev: Events,
    private perConn = 200,
    private readonly silentMs = { delayed: 30_000, recycle: 90_000 }
  ) {
    this.watchdog = setInterval(() => this.check(), 5_000)
  }

  setSymbols(symbols: readonly string[], perConn = this.perConn): void {
    this.perConn = perConn
    const groups = partition(
      [...new Set(symbols)].sort(),
      this.conns.map((c) => [...c.symbols]),
      perConn
    )
    groups.forEach((g, i) => {
      let c = this.conns[i]
      if (!c) {
        c = new KlineConnection(this.nextConnId++, this.ev)
        this.conns[i] = c
        this.openedAt.set(c, Date.now())
      }
      c.setSymbols(g)
    })
    // drop connections that ended up empty
    for (let i = this.conns.length - 1; i >= 0; i--) {
      if (!this.conns[i]!.symbols.size) {
        this.conns[i]!.dispose()
        this.conns.splice(i, 1)
      }
    }
    this.ev.state()
  }

  private check(): void {
    const now = Date.now()
    for (const c of this.conns) {
      if (c.state === 'open' && now - c.lastMessageAt > this.silentMs.recycle) {
        log.warn('ws silent too long; recycling')
        c.recycle()
      }
      const opened = this.openedAt.get(c) ?? now
      if (now - opened > 23.5 * 3600_000) {
        this.openedAt.set(c, now)
        c.recycle() // proactive, before Binance's hard 24h cut
      }
    }
    this.ev.state()
  }

  snapshot(): { streams: number; connections: number; states: ConnState[]; silentMs: number; latencyMs: number } {
    const now = Date.now()
    return {
      streams: this.conns.reduce((a, c) => a + c.symbols.size, 0),
      connections: this.conns.length,
      states: this.conns.map((c) => c.state),
      silentMs: Math.max(0, ...this.conns.filter((c) => c.state === 'open').map((c) => now - c.lastMessageAt)),
      latencyMs: Math.max(0, ...this.conns.map((c) => c.maxLatencyMs))
    }
  }

  get delayedThresholdMs(): number {
    return this.silentMs.delayed
  }

  dispose(): void {
    clearInterval(this.watchdog)
    for (const c of this.conns) c.dispose()
    this.conns = []
  }
}
