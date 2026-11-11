import type { NewsConfig } from '@shared/config'
import type { EconomicEvent, NewsState } from '@shared/news'

const MIN = 60_000

/** Events that open a news window under the current config. */
const windowEvents = (events: readonly EconomicEvent[], cfg: NewsConfig): EconomicEvent[] =>
  events.filter((e) => cfg.currencies.includes(e.currency) && (cfg.windowImpacts as string[]).includes(e.impact))

/** Active news window at `now`: [time − before, time + after] of a qualifying event. */
export function activeWindow(events: readonly EconomicEvent[], cfg: NewsConfig, now: number): NewsState['window'] {
  let best: NewsState['window'] = null
  for (const e of windowEvents(events, cfg)) {
    const start = e.time - cfg.windowBeforeMin * MIN
    const end = e.time + cfg.windowAfterMin * MIN
    if (now >= start && now <= end && (!best || end > best.endsAt)) best = { eventId: e.id, title: e.title, time: e.time, endsAt: end }
  }
  return best
}

/** Next upcoming event of interest (currency + impact filter). */
export function nextEvent(events: readonly EconomicEvent[], cfg: NewsConfig, now: number): NewsState['nextEvent'] {
  const up = events
    .filter((e) => e.time > now && cfg.currencies.includes(e.currency) && (cfg.impacts as string[]).includes(e.impact))
    .sort((a, b) => a.time - b.time)[0]
  return up ? { id: up.id, title: up.title, time: up.time, impact: up.impact } : null
}

/** Bot gate: true when new positions must not be opened because of a news window. */
export function blocksNewPositions(window: NewsState['window'], cfg: NewsConfig): boolean {
  return window !== null && !cfg.newsStrategyEnabled
}
