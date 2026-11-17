import type { BotTrade } from '@shared/bot'
import { effectiveLadder, type ExitPlan } from '../strategy/exit'

type T = Pick<BotTrade, 'entry' | 'slInitial' | 'direction' | 'tp'> & { exitPlan: ExitPlan | null }

/** R of a price for a trade (1R = |entry − initial SL|, + = in profit). */
export function rAt(t: Pick<BotTrade, 'entry' | 'slInitial' | 'direction'>, price: number): number {
  const risk = Math.abs(t.entry - t.slInitial)
  if (!(risk > 0)) return 0
  return (t.direction === 'bullish' ? price - t.entry : t.entry - price) / risk
}

export const fmtR = (r: number): string => `${r > 0 ? '+' : ''}${Math.abs(r) < 0.005 ? '0' : r.toFixed(2)}R`

const px = (x: number): number => Number(x.toPrecision(6))

const priceAt = (t: Pick<BotTrade, 'entry' | 'slInitial' | 'direction'>, r: number): number => {
  const risk = Math.abs(t.entry - t.slInitial)
  return px(t.direction === 'bullish' ? t.entry + r * risk : t.entry - r * risk)
}

/** "TP 1.234 (+2.50R)" or "TP trailing". */
export const tpText = (t: T): string => (t.tp === null ? 'TP trailing (tanpa TP)' : `TP ${t.tp} (${fmtR(rAt(t, t.tp))})`)

/** Exit ladder as price targets: "1R @1.23 → SL BE · 3R @1.30 → tutup 50% + SL +1R". Empty when no ladder. */
export function targetsText(t: T): string {
  if (!t.exitPlan?.ladder.length) return ''
  const steps = effectiveLadder(t.exitPlan, t.entry, t.slInitial)
    .filter((s) => t.tp === null || s.atR < rAt(t, t.tp) - 1e-9)
    .map((s) => {
      const act = [s.closePct ? `tutup ${s.closePct}%` : '', s.slToR ? `SL ${fmtR(s.slToR)}` : 'SL BE'].filter(Boolean).join(' + ')
      return `${s.atR}R @${priceAt(t, s.atR)} → ${act}`
    })
  const trail = t.exitPlan.trailStepR > 0 ? ` · lalu trailing (best − ${t.exitPlan.trailGapR}R)` : ''
  return steps.length ? `target: ${steps.join(' · ')}${trail}` : ''
}
