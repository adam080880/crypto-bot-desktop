import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Bucket, BucketUnit, CurvePoint } from '@shared/dashboard'

/** Small SVG charts for the Dashboard: cumulative PnL line and PnL per bucket bars. Single series each (no legend). */

const M = { l: 52, r: 12, t: 10, b: 22 }

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.floor(e!.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** 3–5 rounded ticks covering [lo, hi]. */
function ticks(lo: number, hi: number): number[] {
  const span = hi - lo || 1
  const raw = span / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v)
  return out
}

const fmtUsd = (v: number): string => `${v < 0 ? '−' : ''}${Math.abs(v) >= 100 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(2)}`
const dayLabel = (t: number): string => new Date(t).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: 'UTC' })

function Tooltip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 12), w - 200)
  return (
    <div className="pointer-events-none absolute z-10 w-48 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md" style={{ left, top: Math.max(0, y - 10) }}>
      {children}
    </div>
  )
}

function YAxis({ ys, y, w }: { ys: number[]; y: (v: number) => number; w: number }) {
  return (
    <g className="text-[10px]">
      {ys.map((v) => (
        <g key={v}>
          <line x1={M.l} x2={w - M.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={v === 0 ? 1.5 : 1} />
          <text x={M.l - 6} y={y(v)} dy="0.32em" textAnchor="end" fill="var(--muted-foreground)">
            {fmtUsd(v)}
          </text>
        </g>
      ))}
    </g>
  )
}

/** Cumulative realised PnL (USDT) over close time, crosshair + tooltip on hover. */
export function PnlCurveChart({ points, height = 200 }: { points: CurvePoint[]; height?: number }) {
  const [ref, w] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  if (!points.length) return <div ref={ref} className="py-10 text-center text-sm text-muted-foreground">Belum ada trade selesai di periode ini.</div>
  const t0 = points[0]!.t
  const t1 = Math.max(points[points.length - 1]!.t, t0 + 1)
  const vals = [0, ...points.map((p) => p.pnl)]
  const ys = ticks(Math.min(...vals), Math.max(...vals))
  const lo = Math.min(ys[0]!, ...vals)
  const hi = Math.max(ys[ys.length - 1]!, ...vals)
  const x = (t: number): number => M.l + ((t - t0) / (t1 - t0)) * (w - M.l - M.r)
  const y = (v: number): number => M.t + ((hi - v) / (hi - lo || 1)) * (height - M.t - M.b)
  // step line from 0 at the first close
  let d = `M${x(t0)},${y(0)}`
  for (const p of points) d += `H${x(p.t)}V${y(p.pnl)}`
  const last = points[points.length - 1]!
  const area = `${d}H${x(last.t)}V${y(0)}Z`
  const color = last.pnl >= 0 ? 'var(--bull)' : 'var(--bear)'
  const hp = hover === null ? null : points[hover]!
  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left
    let best = 0
    for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i]!.t) - px) < Math.abs(x(points[best]!.t) - px)) best = i
    setHover(best)
  }
  const xt = [t0, t0 + (t1 - t0) / 2, t1]
  return (
    <div ref={ref} className="relative">
      <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="PnL kumulatif">
        <YAxis ys={ys} y={y} w={w} />
        {xt.map((t, i) => (
          <text key={i} x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} className="text-[10px]" fill="var(--muted-foreground)">
            {dayLabel(t)}
          </text>
        ))}
        <path d={area} fill={color} opacity={0.08} />
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        {hp && (
          <>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={M.t} y2={height - M.b} stroke="var(--muted-foreground)" strokeDasharray="3 3" />
            <circle cx={x(hp.t)} cy={y(hp.pnl)} r={4} fill={color} stroke="var(--card)" strokeWidth={2} />
          </>
        )}
      </svg>
      {hp && (
        <Tooltip x={x(hp.t)} y={y(hp.pnl)} w={w}>
          <div className="text-muted-foreground">{new Date(hp.t).toLocaleString('id-ID', { hour12: false })}</div>
          <div className="num font-medium">
            Kumulatif {fmtUsd(hp.pnl)} USDT · {hp.r.toFixed(2)}R
          </div>
          <div className="num text-muted-foreground">
            {hp.trade.symbol} {hp.trade.direction === 'bullish' ? 'LONG' : 'SHORT'} {fmtUsd(hp.trade.pnl ?? 0)} USDT
          </div>
        </Tooltip>
      )}
    </div>
  )
}

const bucketLabel = (b: Bucket, unit: BucketUnit): string =>
  unit === 'month'
    ? new Date(b.start).toLocaleDateString('id-ID', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    : unit === 'week'
      ? `mg ${dayLabel(b.start)}`
      : dayLabel(b.start)

/** PnL per day / week / month: bars from the zero line (rounded data end), green up / red down, tooltip per bar. */
export function BucketBars({ data, unit, height = 180 }: { data: Bucket[]; unit: BucketUnit; height?: number }) {
  const [ref, w] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  if (!data.length) return <div ref={ref} className="py-10 text-center text-sm text-muted-foreground">Belum ada data.</div>
  const vals = [0, ...data.map((b) => b.stat.pnl)]
  const ys = ticks(Math.min(...vals), Math.max(...vals))
  const lo = Math.min(ys[0]!, ...vals)
  const hi = Math.max(ys[ys.length - 1]!, ...vals)
  const y = (v: number): number => M.t + ((hi - v) / (hi - lo || 1)) * (height - M.t - M.b)
  const slot = (w - M.l - M.r) / data.length
  const bw = Math.max(2, Math.min(28, slot - 2))
  const every = Math.ceil(data.length / Math.max(1, Math.floor((w - M.l - M.r) / 64)))
  const bar = (v: number, cx: number): string => {
    const x0 = cx - bw / 2
    const y0 = y(0)
    const y1 = y(v)
    const h = Math.abs(y1 - y0)
    const r = Math.min(4, bw / 2, h)
    if (h < 0.5) return `M${x0},${y0}h${bw}v-0.5h${-bw}Z`
    return v >= 0
      ? `M${x0},${y0}V${y1 + r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + bw - r}Q${x0 + bw},${y1} ${x0 + bw},${y1 + r}V${y0}Z`
      : `M${x0},${y0}V${y1 - r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + bw - r}Q${x0 + bw},${y1} ${x0 + bw},${y1 - r}V${y0}Z`
  }
  const hb = hover === null ? null : data[hover]!
  return (
    <div ref={ref} className="relative">
      <svg width={w} height={height} role="img" aria-label="PnL per periode" onMouseLeave={() => setHover(null)}>
        <YAxis ys={ys} y={y} w={w} />
        {data.map((b, i) => {
          const cx = M.l + slot * (i + 0.5)
          return (
            <g key={b.start} onMouseEnter={() => setHover(i)}>
              <rect x={M.l + slot * i} y={M.t} width={slot} height={height - M.t - M.b} fill="transparent" />
              <path d={bar(b.stat.pnl, cx)} fill={b.stat.pnl >= 0 ? 'var(--bull)' : 'var(--bear)'} opacity={hover === null || hover === i ? 1 : 0.55} />
              {i % every === 0 && (
                <text x={cx} y={height - 6} textAnchor="middle" className="text-[10px]" fill="var(--muted-foreground)">
                  {bucketLabel(b, unit)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {hb && (
        <Tooltip x={M.l + slot * (hover! + 0.5)} y={y(Math.max(0, hb.stat.pnl))} w={w}>
          <div className="text-muted-foreground">{bucketLabel(hb, unit)} (UTC)</div>
          <div className="num font-medium">
            {fmtUsd(hb.stat.pnl)} USDT · {hb.stat.totalR.toFixed(2)}R
          </div>
          <div className="num text-muted-foreground">
            {hb.stat.trades} trade · {hb.stat.wins}/{hb.stat.bes}/{hb.stat.losses} · WR {hb.stat.wr === null ? '—' : `${Math.round(hb.stat.wr * 100)}%`}
          </div>
        </Tooltip>
      )}
    </div>
  )
}
