import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp
} from 'lightweight-charts'
import type { Setup, SmcAnalysis } from '@shared/smc'
import { TF_MS, weekStartUtc } from '@shared/timeframes'

/** fancy-canvas target type, taken from lightweight-charts' own signature (no direct dependency). */
type CanvasRenderingTarget2D = Parameters<IPrimitivePaneRenderer['draw']>[0]

export const LAYERS = ['structure', 'ob', 'fvg', 'srflip', 'ocl', 'qm', 'liquidity', 'swingLiq', 'setups', 'history'] as const
export type Layer = (typeof LAYERS)[number]
export type Layers = Record<Layer, boolean>

export const LAYER_LABEL: Record<Layer, string> = {
  structure: 'Structure',
  ob: 'OB',
  fvg: 'FVG',
  srflip: 'RBS/SBR',
  ocl: 'OCL',
  qm: 'QM',
  liquidity: 'Liquidity (wick)',
  swingLiq: 'Liquidity (swing)',
  setups: 'Setup',
  history: 'Riwayat'
}

export const DEFAULT_LAYERS: Layers = {
  structure: true,
  ob: true,
  fvg: true,
  srflip: true,
  ocl: false,
  qm: true,
  liquidity: true,
  swingLiq: true,
  setups: true,
  history: false
}

export const COLORS = {
  bull: '#26b07e',
  bear: '#ef5350',
  fvg: '#9aa0aa',
  liq: '#a78bfa',
  qm: '#f5b041',
  ocl: '#38bdf8',
  text: '#c9ced6'
}

const MAX_PER_KIND = 150
/** Lines never run to the chart's right edge: they stop at their ending event or after N candles. */
const EXTEND_BARS = 30
/** Without "Riwayat": only the N nearest active zones above and below price per kind. */
const NEAREST_PER_SIDE = 3

interface OverlayData {
  analysis: SmcAnalysis | null
  setups: Setup[]
  layers: Layers
  lastClose: number | null
}

const fmt = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))

const alpha = (hex: string, a: number): string =>
  `${hex}${Math.round(a * 255)
    .toString(16)
    .padStart(2, '0')}`

/**
 * Series primitive that paints SMC zones/levels behind the candles.
 * Rectangles run from the zone's origin to the event that ended it (invalid / filled / swept)
 * or to the right edge while still active.
 */
export class SmcOverlay implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private series: ISeriesApi<SeriesType, Time> | null = null
  private requestUpdate: (() => void) | null = null
  private data: OverlayData = { analysis: null, setups: [], layers: DEFAULT_LAYERS, lastClose: null }
  private readonly renderer: IPrimitivePaneRenderer = { draw: () => undefined, drawBackground: (t) => this.draw(t) }
  private readonly views: readonly IPrimitivePaneView[] = [{ zOrder: () => 'bottom', renderer: () => this.renderer }]

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = p.chart
    this.series = p.series
    this.requestUpdate = p.requestUpdate
  }

  detached(): void {
    this.chart = null
    this.series = null
    this.requestUpdate = null
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views
  }

  set(patch: Partial<OverlayData>): void {
    this.data = { ...this.data, ...patch }
    this.requestUpdate?.()
  }

  private draw(target: CanvasRenderingTarget2D): void {
    const { analysis: a, layers, setups } = this.data
    const chart = this.chart
    const series = this.series
    if (!a || !chart || !series) return
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = mediaSize.width
      const ts = chart.timeScale()
      // Snap any timestamp to the open of the displayed timeframe's candle (setups come from 15m).
      const snap = (t: number): number =>
        a.timeframe === '1w' ? weekStartUtc(t) : Math.floor(t / TF_MS[a.timeframe]) * TF_MS[a.timeframe]
      const x = (t: number): number | null => ts.timeToCoordinate((snap(t) / 1000) as UTCTimestamp)
      const spacing = ts.options().barSpacing
      /** End x: the earliest ending event, capped at EXTEND_BARS candles after the start. */
      const xEnd = (x0: number, ...ends: (number | null)[]): number => {
        const cap = x0 + EXTEND_BARS * spacing
        let best = cap
        for (const t of ends) {
          if (t === null) continue
          const xe = x(t)
          if (xe !== null && xe < best) best = xe
        }
        return Math.max(best, x0 + spacing) // at least one candle wide
      }
      const y = (p: number): number | null => series.priceToCoordinate(p)
      const keep = (endT: number | null): boolean => layers.history || endT === null
      const ref = this.data.lastClose
      /** Active zones nearest to price (N above + N below); everything recent when showing history. */
      const pick = <T>(items: readonly T[], endOf: (x: T) => number | null, priceOf: (x: T) => number, n = NEAREST_PER_SIDE): T[] => {
        const kept = items.filter((it) => keep(endOf(it)))
        if (layers.history || ref === null) return kept.slice(-MAX_PER_KIND)
        const above = kept.filter((it) => priceOf(it) >= ref).sort((p, q) => priceOf(p) - priceOf(q)).slice(0, n)
        const below = kept.filter((it) => priceOf(it) < ref).sort((p, q) => priceOf(q) - priceOf(p)).slice(0, n)
        return [...above, ...below]
      }
      ctx.font = '10px "JetBrains Mono Variable", monospace'
      // simple label de-cluttering: shift a label up/down if it would overlap one already drawn
      const placed: { x0: number; x1: number; y: number }[] = []
      const freeLabelY = (lx: number, w: number, want: number): number | null => {
        for (const dy of [0, -11, 11, -22, 22]) {
          const cand = want + dy
          if (!placed.some((p) => Math.abs(p.y - cand) < 11 && lx < p.x1 && lx + w > p.x0)) {
            placed.push({ x0: lx, x1: lx + w, y: cand })
            return cand
          }
        }
        return null // too crowded: skip the label, keep the line
      }
      ctx.textBaseline = 'bottom'

      /** Outline-only box (no background fill — keeps the chart readable). */
      const rect = (t0: number, ends: (number | null)[], p1: number, p2: number, stroke: string, dash?: number[]): number | null => {
        const x0 = x(t0)
        const ya = y(p1)
        const yb = y(p2)
        if (x0 === null || ya === null || yb === null) return null
        const x1 = xEnd(x0, ...ends)
        ctx.setLineDash(dash ?? [])
        ctx.strokeStyle = stroke
        ctx.strokeRect(x0 + 0.5, Math.min(ya, yb) + 0.5, Math.max(1, x1 - x0), Math.max(1, Math.abs(yb - ya)))
        ctx.setLineDash([])
        return x0
      }
      const hline = (t0: number, ends: (number | null)[], p: number, color: string, dash: number[] = [], label?: string, width = 1): void => {
        const x0 = x(t0)
        const yy = y(p)
        if (x0 === null || yy === null) return
        const x1 = xEnd(x0, ...ends)
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.setLineDash(dash)
        ctx.beginPath()
        ctx.moveTo(x0, Math.round(yy) + 0.5)
        ctx.lineTo(x1, Math.round(yy) + 0.5)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.lineWidth = 1
        if (label) {
          const w = ctx.measureText(label).width
          const right = Math.min(x1, W) - w - 4
          const ly = freeLabelY(right, w, yy - 2)
          if (right > Math.max(x0, 0) && ly !== null) {
            ctx.fillStyle = color
            ctx.fillText(label, right, ly)
          }
        }
      }

      if (layers.fvg)
        for (const f of pick(a.fvgs, (f) => f.filledT, (f) => (f.top + f.bottom) / 2))
          rect(f.t, [f.touchedT, f.filledT], f.bottom, f.top, alpha(COLORS.fvg, 0.45), [2, 2])

      if (layers.ob)
        for (const ob of pick(a.orderBlocks, (o) => o.invalidT, (o) => o.line)) {
          const col = ob.direction === 'bullish' ? COLORS.bull : COLORS.bear
          hline(ob.t, [ob.hitT, ob.invalidT], ob.line, col, [], ob.hasFvg ? 'OB+FVG' : 'OB')
        }

      if (layers.liquidity)
        for (const l of pick(a.liquidity.filter((l) => l.kind === 'wick'), (l) => l.sweptT, (l) => l.top))
          hline(l.t, [l.sweptT], l.side === 'sell' ? l.bottom : l.top, alpha(COLORS.liq, 0.9), [3, 3], 'LIQ')

      if (layers.swingLiq)
        for (const l of pick(a.liquidity.filter((l) => l.kind === 'swing'), (l) => l.sweptT, (l) => l.top))
          hline(l.t, [l.sweptT], l.top, alpha(COLORS.liq, 0.85), [2, 4], `${l.side === 'buy' ? 'BSL' : 'SSL'}${l.equal ? ' =' : ''}`)

      if (layers.srflip)
        for (const f of pick(a.srFlips, (f) => f.invalidT, (f) => f.level))
          hline(f.breakT, [f.hitT, f.invalidT], f.level, f.direction === 'bullish' ? COLORS.bull : COLORS.bear, [6, 3], `${f.kind}${f.hasFvg ? '+FVG' : ''}`)

      if (layers.ocl) {
        for (const o of pick(a.ocls, (o) => o.invalidT, (o) => o.level))
          hline(o.breakT ?? o.t, [o.hitT, o.invalidT], o.level, COLORS.ocl, [1, 3], o.kind === 'OCL' ? 'OCL' : 'OCL BREAK')
      }

      if (layers.qm)
        for (const q of pick(a.qms, (q) => q.invalidT, (q) => q.level, 2))
          hline(q.points.h1, [q.hitT, q.invalidT], q.level, COLORS.qm, [], `QM ${q.direction === 'bullish' ? 'buy' : 'sell'}`, 1.5)

      if (layers.structure)
        for (const b of a.breaks.slice(layers.history ? -MAX_PER_KIND : -3)) hline(b.swingT, [b.t], b.level, COLORS.text, [4, 2], 'BOS')

      if (layers.setups) {
        const shown = setups.filter((s) => layers.history || s.status === 'pending' || s.status === 'triggered')
        for (const s of shown) {
          const col = s.direction === 'bullish' ? COLORS.bull : COLORS.bear
          const end = s.statusT // entry hit / TP / SL / invalid / expired — whichever came
          // position tool: starts at the OB valid (the POI that produced the entry), not across the chart
          hline(s.obValid.t, [end], s.entry, col, [], `ENTRY ${fmt(s.entry)} · ${s.rr}R · skor ${s.score}`, 2)
          hline(s.obValid.t, [end], s.sl, COLORS.bear, [4, 3], `SL ${fmt(s.sl)}`)
          hline(s.obValid.t, [end], s.tp, COLORS.bull, [4, 3], `TP ${fmt(s.tp)}`)
        }
      }
    })
  }
}
