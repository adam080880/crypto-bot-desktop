import { tradeOutcome, tradeR, tradeStats, type BotTrade, type TradeStat } from './bot'
import { POI_LABEL } from './smc'

/** Dashboard (live trades only): filters, buckets, breakdowns and the open-position summary. Pure, times in UTC. */

export interface DashboardData {
  /** Live trades that were filled or are still pending (cancelled-without-fill rows are left out). */
  trades: BotTrade[]
  /** Last closed 1m close per symbol of the open trades (DB, ≤ ~1–2 min old). */
  marks: Record<string, { price: number; t: number }>
}

export interface DashFilter {
  /** Close time window [from, to) in ms; null = open-ended. */
  from: number | null
  to: number | null
  /** Empty = all models. */
  models: readonly string[]
  dir: 'all' | 'bullish' | 'bearish'
}

const DAY = 86_400_000

/** UTC midnight of the day containing t. */
export const utcDay = (t: number): number => Math.floor(t / DAY) * DAY
/** Monday 00:00 UTC of the week containing t (1970-01-01 was a Thursday). */
export const utcWeek = (t: number): number => utcDay(t) - ((new Date(utcDay(t)).getUTCDay() + 6) % 7) * DAY
export const utcMonth = (t: number): number => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

export type BucketUnit = 'day' | 'week' | 'month'
const BUCKET: Record<BucketUnit, (t: number) => number> = { day: utcDay, week: utcWeek, month: utcMonth }

const passModelDir = (t: BotTrade, f: Pick<DashFilter, 'models' | 'dir'>): boolean => (!f.models.length || f.models.includes(t.model)) && (f.dir === 'all' || t.direction === f.dir)

/** Closed (filled) trades whose close time falls in the window and that pass the model / direction filter, in close order. */
export function closedIn(trades: readonly BotTrade[], f: DashFilter): BotTrade[] {
  return trades
    .filter((t) => tradeOutcome(t) !== null && t.closedAt !== null && (f.from === null || t.closedAt >= f.from) && (f.to === null || t.closedAt < f.to) && passModelDir(t, f))
    .sort((a, b) => a.closedAt! - b.closedAt!)
}

export interface Bucket {
  start: number
  stat: TradeStat
}

/** Realised result per UTC day / week (Monday) / month, oldest first, empty buckets left out. */
export function buckets(closed: readonly BotTrade[], unit: BucketUnit): Bucket[] {
  const by = new Map<number, BotTrade[]>()
  for (const t of closed) {
    const k = BUCKET[unit](t.closedAt!)
    by.set(k, [...(by.get(k) ?? []), t])
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([start, ts]) => ({ start, stat: tradeStats(ts)! }))
}

export interface CurvePoint {
  t: number
  /** Cumulative PnL (USDT) and R after this trade. */
  pnl: number
  r: number
  trade: BotTrade
}

/** Cumulative realised PnL in close order. */
export function pnlCurve(closed: readonly BotTrade[]): CurvePoint[] {
  let pnl = 0
  let r = 0
  return closed.map((t) => {
    pnl += t.pnl ?? 0
    r += tradeR(t) ?? 0
    return { t: t.closedAt!, pnl, r, trade: t }
  })
}

/** Largest peak-to-trough fall of cumulative PnL (USDT, ≥ 0). */
export function maxDdUsd(curve: readonly CurvePoint[]): number {
  let peak = 0
  let dd = 0
  for (const p of curve) {
    peak = Math.max(peak, p.pnl)
    dd = Math.max(dd, peak - p.pnl)
  }
  return dd
}

export type GroupKey = 'model' | 'poi' | 'poiTf' | 'poiKind' | 'dir' | 'symbol' | 'reason' | 'weekday' | 'hour'

export const GROUP_LABEL: Record<GroupKey, string> = {
  model: 'Model',
  poi: 'POI (jenis + TF)',
  poiTf: 'TF POI',
  poiKind: 'Jenis POI',
  dir: 'Arah',
  symbol: 'Koin',
  reason: 'Alasan exit',
  weekday: 'Hari entry (UTC)',
  hour: 'Jam entry (UTC)'
}

const WEEKDAY = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
const poiName = (t: BotTrade): string => POI_LABEL[t.poi.kind] ?? t.poi.kind

export function groupOf(t: BotTrade, key: GroupKey): string {
  const at = t.filledAt ?? t.createdAt
  switch (key) {
    case 'model':
      return t.model
    case 'poi':
      return `${poiName(t)} ${t.poi.timeframe}`
    case 'poiTf':
      return t.poi.timeframe
    case 'poiKind':
      return poiName(t)
    case 'dir':
      return t.direction === 'bullish' ? 'LONG' : 'SHORT'
    case 'symbol':
      return t.symbol
    case 'reason':
      return t.reason ?? '—'
    case 'weekday':
      return WEEKDAY[new Date(at).getUTCDay()]!
    case 'hour':
      return `${String(new Date(at).getUTCHours()).padStart(2, '0')}:00`
  }
}

export interface GroupRow extends TradeStat {
  key: string
}

/** tradeStats per group, best total R first. */
export function breakdown(closed: readonly BotTrade[], key: GroupKey): GroupRow[] {
  const by = new Map<string, BotTrade[]>()
  for (const t of closed) {
    const g = groupOf(t, key)
    by.set(g, [...(by.get(g) ?? []), t])
  }
  return [...by.entries()].map(([k, ts]) => ({ key: k, ...tradeStats(ts)! })).sort((a, b) => b.totalR - a.totalR || b.trades - a.trades)
}

export interface OpenRow {
  trade: BotTrade
  /** Quantity still open (filled − ladder partials). */
  qty: number
  mark: number | null
  markT: number | null
  /** Unrealised PnL at the mark (USDT, before exit fee) + partials already booked. */
  upnl: number | null
  /** upnl ÷ planned risk. */
  r: number | null
  /** Result if the current stop is hit now (USDT, before fees; > 0 = stop already locks profit). */
  atStop: number
  /** Margin held (notional at entry ÷ leverage). */
  margin: number
}

export interface OpenSummary {
  rows: OpenRow[]
  /** Sum over rows with a mark. */
  upnl: number
  r: number
  /** Rows without a mark price. */
  noMark: number
  atStop: number
  margin: number
  pending: { count: number; risk: number; margin: number }
}

/** Filled positions still open (with floating PnL at the mark) and pending limits. */
export function openSummary(trades: readonly BotTrade[], marks: DashboardData['marks'], f: Pick<DashFilter, 'models' | 'dir'>): OpenSummary {
  const rows: OpenRow[] = []
  const pending = { count: 0, risk: 0, margin: 0 }
  for (const t of trades) {
    if (!passModelDir(t, f)) continue
    if (t.status === 'pending') {
      pending.count++
      pending.risk += t.riskUsd
      pending.margin += (t.qty * t.entry) / Math.max(1, t.leverage)
      continue
    }
    if (t.status !== 'open') continue
    const sg = t.direction === 'bullish' ? 1 : -1
    const qty = Math.max(0, (t.filledQty ?? t.qty) - t.closedQty)
    const m = marks[t.symbol] ?? null
    const upnl = m ? sg * (m.price - t.entry) * qty + t.realized : null
    rows.push({
      trade: t,
      qty,
      mark: m?.price ?? null,
      markT: m?.t ?? null,
      upnl,
      r: upnl !== null && t.riskUsd > 0 ? upnl / t.riskUsd : null,
      atStop: sg * (t.sl - t.entry) * qty + t.realized,
      margin: (qty * t.entry) / Math.max(1, t.leverage)
    })
  }
  rows.sort((a, b) => (b.r ?? -Infinity) - (a.r ?? -Infinity))
  const withMark = rows.filter((x) => x.upnl !== null)
  return {
    rows,
    upnl: withMark.reduce((s, x) => s + x.upnl!, 0),
    r: withMark.reduce((s, x) => s + (x.r ?? 0), 0),
    noMark: rows.length - withMark.length,
    atStop: rows.reduce((s, x) => s + x.atStop, 0),
    margin: rows.reduce((s, x) => s + x.margin, 0),
    pending
  }
}
