import type { BotTrade } from '@shared/bot'
import type { Timeframe } from '@shared/timeframes'
import { useAppStore } from '@/stores/appStore'

/**
 * A past trade to show on the Chart (read once by the Chart page from `chart.focus`).
 * Backtest trades and bot trades use the same shape; optional lines are drawn when present.
 */
export interface ChartFocus {
  symbol: string
  /** Entry time (or setup time) and the end of the period to show. */
  t: number
  until: number
  entry: number
  /** Initial stop (1R). */
  sl: number
  dir: 'bullish' | 'bearish'
  /** Banner text, e.g. "trade backtest" / "trade bot M4". */
  label?: string
  /** Last stop when it moved (BE / trailing). */
  slFinal?: number | null
  tp?: number | null
  exit?: number | null
}

const set = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* storage unavailable */
  }
}

/** Open the Chart on a symbol, optionally on a timeframe and focused on a trade. */
export function openChart(symbol: string, o: { tf?: Timeframe; focus?: ChartFocus } = {}): void {
  set('chart.symbol', symbol)
  if (o.tf) set('chart.tf', o.tf)
  if (o.focus) set('chart.focus', JSON.stringify(o.focus))
  useAppStore.getState().setPage('chart')
}

/** Open the Backtest page on a symbol; `run` starts it right away (unless a result is already cached). */
export function openBacktest(symbol: string, run = true): void {
  set('backtest.symbol', JSON.stringify(symbol))
  if (run) set('backtest.autorun', JSON.stringify(symbol))
  useAppStore.getState().setPage('backtest')
}

/** Timeframe that fits a model: M5 trades on 4h candles, the rest are entered on 15m. */
export const tfForModel = (model: string): Timeframe => (model === 'M5' ? '1h' : '15m')

/** Focus for a bot trade (filled → closed, or still running). */
export function botTradeFocus(t: BotTrade, now = Date.now()): ChartFocus {
  return {
    symbol: t.symbol,
    t: t.filledAt ?? t.createdAt,
    until: t.closedAt ?? now,
    entry: t.entry,
    sl: t.slInitial,
    dir: t.direction,
    label: `trade bot ${t.model} ${t.mode}`,
    slFinal: t.sl !== t.slInitial ? t.sl : null,
    tp: t.tp,
    exit: t.exitPrice
  }
}
