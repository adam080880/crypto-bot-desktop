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
/** Without "Riwayat": only the N nearest active zones above and below price per kind. */
const NEAREST_PER_SIDE = 3

interface OverlayData {
  analysis: SmcAnalysis | null
  setups: Setup[]
  layers: Layers
  lastClose: number | null
}

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
      const x = (t: number): number | null => ts.timeToCoordinate((t / 1000) as UTCTimestamp)
      const xEnd = (t: number | null): number => (t === null ? W : (x(t) ?? W))
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
      ctx.textBaseline = 'bottom'

      const rect = (t0: number, t1: number | null, p1: number, p2: number, fill: string, stroke?: string, dash?: number[]): number | null => {
        const x0 = x(t0)
        const ya = y(p1)
        const yb = y(p2)
        if (x0 === null || ya === null || yb === null) return null
        const x1 = xEnd(t1)
        ctx.fillStyle = fill
        ctx.fillRect(x0, Math.min(ya, yb), Math.max(1, x1 - x0), Math.max(1, Math.abs(yb - ya)))
        if (stroke) {
          ctx.setLineDash(dash ?? [])
          ctx.strokeStyle = stroke
          ctx.strokeRect(x0 + 0.5, Math.min(ya, yb) + 0.5, Math.max(1, x1 - x0), Math.max(1, Math.abs(yb - ya)))
          ctx.setLineDash([])
        }
        return x0
      }
      const hline = (t0: number, t1: number | null, p: number, color: string, dash: number[] = [], label?: string, width = 1): void => {
        const x0 = x(t0)
        const yy = y(p)
        if (x0 === null || yy === null) return
        const x1 = xEnd(t1)
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
          ctx.fillStyle = color
          const w = ctx.measureText(label).width
          const right = Math.min(x1, W) - w - 4
          if (right > Math.max(x0, 0)) ctx.fillText(label, right, yy - 2)
        }
      }

      if (layers.fvg)
        for (const f of pick(a.fvgs, (f) => f.filledT, (f) => (f.top + f.bottom) / 2))
          rect(f.t, f.filledT, f.bottom, f.top, alpha(COLORS.fvg, 0.16))

      if (layers.ob)
        for (const ob of pick(a.orderBlocks, (o) => o.invalidT, (o) => o.line)) {
          const col = ob.direction === 'bullish' ? COLORS.bull : COLORS.bear
          const x0 = rect(ob.t, ob.invalidT, ob.line, ob.bodyFar, alpha(col, 0.14))
          if (x0 === null) continue
          hline(ob.t, ob.invalidT, ob.line, col, [], ob.hasFvg ? 'OB+FVG' : 'OB')
        }

      if (layers.liquidity)
        for (const l of pick(a.liquidity.filter((l) => l.kind === 'wick'), (l) => l.sweptT, (l) => l.top))
          rect(l.t, l.sweptT, l.bottom, l.top, alpha(COLORS.liq, 0.18), alpha(COLORS.liq, 0.6), [3, 3])

      if (layers.swingLiq)
        for (const l of pick(a.liquidity.filter((l) => l.kind === 'swing'), (l) => l.sweptT, (l) => l.top))
          hline(l.t, l.sweptT, l.top, alpha(COLORS.liq, 0.85), [2, 4], `${l.side === 'buy' ? 'BSL' : 'SSL'}${l.equal ? ' =' : ''}`)

      if (layers.srflip)
        for (const f of pick(a.srFlips, (f) => f.invalidT, (f) => f.level))
          hline(f.breakT, f.invalidT, f.level, f.direction === 'bullish' ? COLORS.bull : COLORS.bear, [6, 3], `${f.kind}${f.hasFvg ? '+FVG' : ''}`)

      if (layers.ocl) {
        for (const o of pick(a.ocls, (o) => o.invalidT, (o) => o.level))
          hline(o.breakT ?? o.t, o.invalidT, o.level, COLORS.ocl, [1, 3], o.kind === 'OCL' ? 'OCL' : 'OCL BREAK')
      }

      if (layers.qm)
        for (const q of pick(a.qms, (q) => q.invalidT, (q) => q.level, 2))
          hline(q.points.h1, q.invalidT, q.level, COLORS.qm, [], `QM ${q.direction === 'bullish' ? 'buy' : 'sell'}`, 1.5)

      if (layers.structure)
        for (const b of a.breaks.slice(layers.history ? -MAX_PER_KIND : -3)) hline(b.swingT, b.t, b.level, COLORS.text, [4, 2], 'BOS')

      if (layers.setups)
        for (const s of setups.filter((s) => s.obValid.timeframe === a.timeframe && (layers.history || s.status === 'pending' || s.status === 'triggered'))) {
          const col = s.direction === 'bullish' ? COLORS.bull : COLORS.bear
          rect(s.obValid.t, s.statusT, s.obValid.line, s.obValid.wickEnd, alpha(col, 0.28), col)
          hline(s.obValid.t, s.statusT, s.obValid.line, col, [], `OB VALID ${s.obValid.hasFvg ? '+FVG ' : ''}(skor ${s.score})`, 2)
        }
    })
  }
}
