import type { ExitConfig } from '@shared/config'
import { TF_MS } from '@shared/timeframes'

/** Fees in % of notional: limit entry / TP / ladder closes = maker; SL = stop-market taker + slippage. */
export interface ExitFees {
  makerFeePct: number
  takerFeePct: number
  slippagePct: number
}

export interface ExitBar {
  t: number
  /** Optional (needed for the reactive-wick order flow; falls back to the close). */
  o?: number
  h: number
  l: number
  c: number
}

export interface ExitFill {
  t: number
  price: number
  /** Share of the ORIGINAL size closed here (0–1). */
  frac: number
  reason: 'sl' | 'tp' | 'ladder' | 'be' | 'trail' | 'orderflow' | 'end'
}

export interface ExitResult {
  done: boolean
  exitT: number | null
  /** Net R after fees (risk = |entry − initial SL|). Includes open remainder at the last close when not done. */
  r: number
  /** Best favourable excursion in R. */
  mfeR: number
  fills: ExitFill[]
  /** Current stop (price) — for live/paper order management. */
  sl: number
  /** Order-flow hold active at the end (ladder/trailing paused). */
  holding: boolean
  /** Times the order flow was confirmed (FVG retest held). */
  orderFlowHolds: number
}

interface Bucket {
  k: number
  o: number
  h: number
  l: number
  c: number
}

export type ExitPlan = Pick<ExitConfig, 'ladder' | 'trailStepR' | 'trailGapR'> &
  Partial<Pick<ExitConfig, 'orderFlowHold' | 'orderFlowTf' | 'orderFlowSignals' | 'orderFlowWickRatio' | 'tightSlPct' | 'tightBeAtR' | 'tightBeLockR'>>

interface LadderStep {
  atR: number
  slToR: number
  closePct: number
  /** Break-even step: also applies while the order flow holds; the stop pays both fees + slippage. */
  be: boolean
}

/**
 * Ladder actually used for a trade. With a tight stop (< tightSlPct % of entry) the break-even step
 * moves to tightBeAtR at the earliest and locks tightBeLockR net of fees.
 */
export function effectiveLadder(plan: ExitPlan, entry: number, sl0: number): LadderStep[] {
  const tight = (plan.tightSlPct ?? 0) > 0 && (Math.abs(entry - sl0) / entry) * 100 < plan.tightSlPct!
  return plan.ladder
    .map((s) =>
      s.slToR === 0 && tight
        ? { atR: Math.max(s.atR, plan.tightBeAtR ?? 2), slToR: plan.tightBeLockR ?? 0.5, closePct: s.closePct, be: true }
        : { ...s, be: s.slToR === 0 }
    )
    .sort((a, b) => a.atR - b.atR)
}

/**
 * Tiered exit (docs/entry-v2.md §4), shared by backtest, paper and live:
 *  - each ladder step fires once price reaches entry + atR × risk: close closePct % of the original
 *    size there (maker) and move the stop to slToR (0 = break-even incl. round-trip fees);
 *    a stop tighter than tightSlPct % takes its BE step at tightBeAtR and locks tightBeLockR net
 *    of fees (effectiveLadder);
 *  - after the last step the stop trails: every trailStepR of new best R → stop = best − trailGapR;
 *  - final TP closes whatever is left (maker); the stop closes the rest (taker + slippage).
 *  - order-flow hold (user): bars are grouped into `orderFlowTf` candles. After entry, a strong move
 *    that leaves an FVG in the trade direction, then a candle that trades back into that FVG and
 *    closes on the right side (retest held) = order flow. While it holds the ladder takes no partials
 *    and the trailing pauses (the 1R → break-even step still applies); the stop goes to the retest
 *    extreme (+buffer) if that is tighter. A close through the FVG breaks it → ladder/trailing resume.
 *    The fill candle is never a signal (it formed partly before the entry).
 *    Reactive wick (user): a candle that comes back to the entry area and rejects it with a long wick
 *    (≥ orderFlowWickRatio of its range and ≥ 1.5 × body, close on the trade side of the entry) also
 *    confirms the POI → hold, stop beyond the wick (if tighter). Needs the bar's open.
 * Per bar, conservative order: stop first, then TP, then ladder/trail (a stop moved on this bar
 * only protects from the next bar on). Feed 1m bars for a realistic result.
 */
export class ExitTracker {
  private readonly bull: boolean
  private readonly risk: number
  private readonly ladder: LadderStep[]
  private sl: number
  private slReason: ExitFill['reason'] = 'sl'
  private remaining = 1
  private step = 0
  private best = 0
  private readonly fills: ExitFill[] = []
  private exitT: number | null = null
  private last: number
  // order flow
  private readonly ofMs: number
  private bucket: Bucket | null = null
  private readonly closed: Bucket[] = []
  private fvg: { top: number; bottom: number; after: number } | null = null
  private holding = false
  private holds = 0
  private fillK: number | null = null

  constructor(
    readonly dir: 'bullish' | 'bearish',
    readonly entry: number,
    readonly sl0: number,
    readonly tp: number | null,
    private readonly plan: ExitPlan,
    private readonly fees: ExitFees,
    /** SL buffer beyond the retest extreme, % of price. */
    private readonly bufferPct = 0.1
  ) {
    this.bull = dir === 'bullish'
    this.risk = Math.abs(entry - sl0)
    this.sl = sl0
    this.last = entry
    this.ofMs = plan.orderFlowHold ? TF_MS[plan.orderFlowTf ?? '15m'] : 0
    this.ladder = effectiveLadder(plan, entry, sl0)
  }

  /** Group bars into order-flow candles; a finished candle is evaluated when the next one starts. */
  private feedBucket(b: ExitBar): void {
    if (!this.ofMs) return
    const k = Math.floor(b.t / this.ofMs)
    this.fillK ??= k
    if (this.bucket && this.bucket.k !== k) {
      // the fill candle itself formed (partly) before the entry: it is not a reaction
      if (this.bucket.k !== this.fillK) this.onBucket(this.bucket)
      this.bucket = null
    }
    if (!this.bucket) this.bucket = { k, o: b.o ?? NaN, h: b.h, l: b.l, c: b.c }
    else {
      this.bucket.h = Math.max(this.bucket.h, b.h)
      this.bucket.l = Math.min(this.bucket.l, b.l)
      this.bucket.c = b.c
    }
  }

  private hold(extreme: number): void {
    const buf = this.bufferPct / 100
    if (!this.holding) this.holds++
    this.holding = true
    // the 1R → break-even step keeps working while holding; once there, the stop never drops below it
    this.moveSl(this.bull ? extreme * (1 - buf) : extreme * (1 + buf), 'orderflow')
  }

  private onBucket(x: Bucket): void {
    const { bull } = this
    const n = this.closed.push(x)
    const signals = this.plan.orderFlowSignals ?? ['fvg', 'wick']
    // reactive wick back at the entry area (within 0.5R of the entry)
    if (signals.includes('wick')) {
      const range = x.h - x.l
      const body = Math.abs(x.c - x.o)
      const wick = bull ? Math.min(x.o, x.c) - x.l : x.h - Math.max(x.o, x.c)
      const nearEntry = bull ? x.l <= this.entry + 0.5 * this.risk : x.h >= this.entry - 0.5 * this.risk
      const closesRight = bull ? x.c > this.entry : x.c < this.entry
      if (Number.isFinite(x.o) && range > 0 && wick >= (this.plan.orderFlowWickRatio ?? 0.5) * range && wick >= 1.5 * body && nearEntry && closesRight)
        this.hold(bull ? x.l : x.h)
    }
    if (!signals.includes('fvg')) return
    // retest / break of the current FVG
    if (this.fvg && n - 1 > this.fvg.after) {
      const broke = bull ? x.c < this.fvg.bottom : x.c > this.fvg.top
      if (broke) {
        this.fvg = null
        this.holding = false
      } else if (bull ? x.l <= this.fvg.top : x.h >= this.fvg.bottom) this.hold(bull ? x.l : x.h)
    }
    // a new FVG in the trade direction from candles formed after the entry
    if (n >= 3) {
      const a = this.closed[n - 3]!
      const z = this.closed[n - 1]!
      if (bull ? z.l > a.h : z.h < a.l) {
        const next = bull ? { top: z.l, bottom: a.h, after: n - 1 } : { top: a.l, bottom: z.h, after: n - 1 }
        // keep following the newest gap while holding; it is the latest order flow
        if (!this.fvg || !this.holding || (bull ? next.bottom > this.fvg.bottom : next.top < this.fvg.top)) this.fvg = next
      }
    }
  }

  /** Price at `r` R from entry; r = 0 → break-even that also pays both fees and the slippage. */
  levelAt(r: number): number {
    if (r === 0) {
      const f = (this.fees.makerFeePct + this.fees.takerFeePct + this.fees.slippagePct) / 100
      return this.bull ? this.entry * (1 + f) : this.entry * (1 - f)
    }
    return this.bull ? this.entry + r * this.risk : this.entry - r * this.risk
  }

  /** Stop that keeps `r` R after paying both fees and the slippage (r = 0 → break-even). */
  netLevelAt(r: number): number {
    const be = this.levelAt(0)
    return this.bull ? be + r * this.risk : be - r * this.risk
  }

  private close(t: number, price: number, frac: number, reason: ExitFill['reason']): void {
    const f = Math.min(frac, this.remaining)
    if (f <= 0) return
    this.fills.push({ t, price, frac: f, reason })
    this.remaining -= f
    if (this.remaining <= 1e-9) {
      this.remaining = 0
      this.exitT = t
    }
  }

  private moveSl(price: number, reason: ExitFill['reason']): void {
    if (this.bull ? price > this.sl : price < this.sl) {
      this.sl = price
      this.slReason = reason
    }
  }

  get done(): boolean {
    return this.remaining === 0
  }

  /** Feed one bar. `fillBar` = the bar in which the entry filled: only the stop is checked there. */
  bar(b: ExitBar, fillBar = false): void {
    if (this.done) return
    const { bull } = this
    this.last = b.c
    this.feedBucket(b)
    if (bull ? b.l <= this.sl : b.h >= this.sl) {
      const px = bull ? this.sl * (1 - this.fees.slippagePct / 100) : this.sl * (1 + this.fees.slippagePct / 100)
      this.close(b.t, px, this.remaining, this.slReason)
      return
    }
    if (fillBar) return
    if (this.tp !== null && (bull ? b.h >= this.tp : b.l <= this.tp)) {
      this.close(b.t, this.tp, this.remaining, 'tp')
      return
    }
    const favR = ((bull ? b.h - this.entry : this.entry - b.l) / this.risk) || 0
    this.best = Math.max(this.best, favR)
    const ladder = this.ladder
    while (this.step < ladder.length && this.best >= ladder[this.step]!.atR) {
      const s = ladder[this.step]!
      // while the order flow holds: only the break-even move applies (no partials, no tighter stop)
      if (s.closePct > 0 && !this.holding) this.close(b.t, this.levelAt(s.atR), s.closePct / 100, 'ladder')
      if (s.be) this.moveSl(this.netLevelAt(s.slToR), 'be')
      else if (!this.holding) this.moveSl(this.levelAt(s.slToR), 'trail')
      this.step++
      if (this.done) return
    }
    if (this.step >= ladder.length && this.plan.trailStepR > 0 && !this.holding) {
      const lastAt = ladder.length ? ladder[ladder.length - 1]!.atR : 0
      const reached = Math.floor(this.best / this.plan.trailStepR) * this.plan.trailStepR
      if (reached > lastAt) {
        const slR = reached - this.plan.trailGapR
        if (slR > 0) this.moveSl(this.levelAt(slR), 'trail')
      }
    }
  }

  result(): ExitResult {
    const m = this.fees.makerFeePct / 100
    const takerish = (reason: ExitFill['reason']): boolean => reason !== 'tp' && reason !== 'ladder'
    let pnl = 0
    const fills = [...this.fills]
    if (!this.done && this.remaining > 0) fills.push({ t: this.exitT ?? 0, price: this.last, frac: this.remaining, reason: 'end' })
    for (const f of fills) {
      const move = this.bull ? f.price - this.entry : this.entry - f.price
      const exitFee = (takerish(f.reason) ? this.fees.takerFeePct / 100 : m) * f.price
      pnl += f.frac * (move - m * this.entry - exitFee)
    }
    return { done: this.done, exitT: this.exitT, r: pnl / this.risk, mfeR: this.best, fills: this.fills, sl: this.sl, holding: this.holding, orderFlowHolds: this.holds }
  }
}
