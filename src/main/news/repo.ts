import { createHash } from 'node:crypto'
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import type { InterpretationRule, NewsConfig } from '@shared/config'
import type { ActualSourceId, Bias, EconomicEvent, EventReaction, Impact, NewsCandidate, ReactionStat } from '@shared/news'
import type { Db } from '../db/client'
import { economicEvents, eventReactions, newsCandidates } from '../db/schema'
import { findRule, interpret } from './interpret'
import { parseFfValue } from './parse'
import type { RawCalendarEvent } from './sources/types'

type Row = typeof economicEvents.$inferSelect

export const eventId = (source: string, e: Pick<RawCalendarEvent, 'title' | 'currency' | 'time'>): string =>
  createHash('sha1').update(`${source}|${e.currency}|${e.title}|${e.time}`).digest('hex').slice(0, 16)

const toEvent = (r: Row): EconomicEvent => ({
  id: r.id,
  source: 'ff',
  title: r.title,
  currency: r.currency,
  impact: r.impact as Impact,
  time: r.time,
  forecastRaw: r.forecastRaw,
  previousRaw: r.previousRaw,
  actualRaw: r.actualRaw,
  forecast: r.forecast,
  previous: r.previous,
  actual: r.actual,
  actualSource: r.actualSource as ActualSourceId | null,
  actualAt: r.actualAt,
  ruleKey: r.ruleKey,
  usdBias: r.usdBias as Bias | null,
  cryptoBias: r.cryptoBias as Bias | null,
  biasReason: r.biasReason
})

export class NewsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Upsert a feed snapshot. Actual values we already have are kept (the feed has none).
   * Events that disappeared from the feed's time span (rescheduled) are removed if they have no actual.
   */
  upsertFeed(source: 'ff', items: readonly RawCalendarEvent[], cfg: NewsConfig): number {
    if (!items.length) return 0
    const now = Date.now()
    const ids = new Set<string>()
    let minT = Infinity
    let maxT = -Infinity
    this.db.transaction((tx) => {
      for (const e of items) {
        const id = eventId(source, e)
        ids.add(id)
        minT = Math.min(minT, e.time)
        maxT = Math.max(maxT, e.time)
        const rule = findRule(e.title, cfg.rules)
        const base = {
          title: e.title,
          currency: e.currency,
          impact: e.impact,
          time: e.time,
          forecastRaw: e.forecastRaw,
          previousRaw: e.previousRaw,
          forecast: parseFfValue(e.forecastRaw),
          previous: parseFfValue(e.previousRaw),
          ruleKey: rule?.key ?? null,
          updatedAt: now
        }
        tx.insert(economicEvents)
          .values({ id, source, ...base })
          .onConflictDoUpdate({ target: economicEvents.id, set: base })
          .run()
      }
      const stale = tx
        .select({ id: economicEvents.id, actual: economicEvents.actual })
        .from(economicEvents)
        .where(and(eq(economicEvents.source, source), gte(economicEvents.time, minT), lte(economicEvents.time, maxT)))
        .all()
      for (const s of stale) if (!ids.has(s.id) && s.actual === null) tx.delete(economicEvents).where(eq(economicEvents.id, s.id)).run()
    })
    return items.length
  }

  list(from: number, to: number): EconomicEvent[] {
    return this.db
      .select()
      .from(economicEvents)
      .where(and(gte(economicEvents.time, from), lte(economicEvents.time, to)))
      .orderBy(economicEvents.time)
      .all()
      .map(toEvent)
  }

  get(id: string): EconomicEvent | null {
    const r = this.db.select().from(economicEvents).where(eq(economicEvents.id, id)).get()
    return r ? toEvent(r) : null
  }

  /** Store an actual (official or manual) and its interpretation. `value=null` clears it. */
  setActual(
    id: string,
    value: number | null,
    raw: string | null,
    source: ActualSourceId | null,
    rule: InterpretationRule | null,
    mode: NewsConfig['cryptoBiasMode']
  ): EconomicEvent | null {
    const e = this.get(id)
    if (!e) return null
    const it = value !== null && rule ? interpret(value, e.forecast, e.previous, rule, mode) : null
    this.db
      .update(economicEvents)
      .set({
        actual: value,
        actualRaw: raw,
        actualSource: value === null ? null : source,
        actualAt: value === null ? null : Date.now(),
        ruleKey: rule?.key ?? e.ruleKey,
        usdBias: it?.usdBias ?? null,
        cryptoBias: it?.cryptoBias ?? null,
        biasReason: it?.reason ?? (value !== null && !rule ? 'tidak ada aturan interpretasi untuk event ini' : null),
        updatedAt: Date.now()
      })
      .where(eq(economicEvents.id, id))
      .run()
    return this.get(id)
  }

  // ---- reactions ---------------------------------------------------------------------------

  hasReaction(eventId: string, symbol: string, horizonMin: number): boolean {
    return !!this.db
      .select({ e: eventReactions.eventId })
      .from(eventReactions)
      .where(and(eq(eventReactions.eventId, eventId), eq(eventReactions.symbol, symbol), eq(eventReactions.horizonMin, horizonMin)))
      .get()
  }

  addReaction(r: EventReaction): void {
    this.db.insert(eventReactions).values({ ...r, computedAt: Date.now() }).onConflictDoNothing().run()
  }

  reactions(eventId: string): EventReaction[] {
    return this.db
      .select()
      .from(eventReactions)
      .where(eq(eventReactions.eventId, eventId))
      .all()
      .map(({ computedAt: _c, ...r }) => r)
  }

  /** Does crypto actually move against USD after events? Grouped by USD bias, symbol, horizon. */
  stats(mode: NewsConfig['cryptoBiasMode']): ReactionStat[] {
    const rows = this.db.$client
      .prepare(
        `SELECT e.usd_bias AS usdBias, r.symbol, r.horizon_min AS horizonMin, r.change_pct AS change
         FROM event_reactions r JOIN economic_events e ON e.id = r.event_id
         WHERE e.usd_bias IS NOT NULL`
      )
      .all() as { usdBias: Bias; symbol: string; horizonMin: number; change: number }[]
    const groups = new Map<string, { usdBias: Bias; symbol: string; horizonMin: number; changes: number[] }>()
    for (const r of rows) {
      const k = `${r.usdBias}|${r.symbol}|${r.horizonMin}`
      const g = groups.get(k) ?? { usdBias: r.usdBias, symbol: r.symbol, horizonMin: r.horizonMin, changes: [] }
      g.changes.push(r.change)
      groups.set(k, g)
    }
    const expectUp = (b: Bias): boolean | null => {
      if (b === 'neutral' || mode === 'off') return null
      return mode === 'inverse' ? b === 'bearish' : b === 'bullish'
    }
    return [...groups.values()]
      .map((g) => {
        const up = expectUp(g.usdBias)
        const hits = up === null ? null : g.changes.filter((c) => (up ? c > 0 : c < 0)).length
        return {
          usdBias: g.usdBias,
          symbol: g.symbol,
          horizonMin: g.horizonMin,
          n: g.changes.length,
          avgChangePct: g.changes.reduce((a, b) => a + b, 0) / g.changes.length,
          ruleHitPct: hits === null ? null : hits / g.changes.length
        }
      })
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.horizonMin - b.horizonMin || a.usdBias.localeCompare(b.usdBias))
  }

  // ---- candidates --------------------------------------------------------------------------

  hasCandidate(eventId: string, symbol: string): boolean {
    return !!this.db
      .select({ id: newsCandidates.id })
      .from(newsCandidates)
      .where(and(eq(newsCandidates.eventId, eventId), eq(newsCandidates.symbol, symbol)))
      .get()
  }

  addCandidate(c: NewsCandidate): void {
    this.db
      .insert(newsCandidates)
      .values({ id: c.id, eventId: c.eventId, symbol: c.symbol, createdAt: c.createdAt, payload: JSON.stringify(c) })
      .onConflictDoNothing()
      .run()
  }

  candidates(limit = 50): NewsCandidate[] {
    return this.db
      .select({ payload: newsCandidates.payload })
      .from(newsCandidates)
      .orderBy(desc(newsCandidates.createdAt))
      .limit(limit)
      .all()
      .map((r) => JSON.parse(r.payload) as NewsCandidate)
  }
}
