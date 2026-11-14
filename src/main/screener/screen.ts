import type { ScreenerConfig } from '@shared/config'
import type { ScreenerRow, ScreenerSetup } from '@shared/screener'
import type { Dir, Setup, StructureBreak } from '@shared/smc'
import { TF_MS, type Timeframe } from '@shared/timeframes'
import type { Poi } from '../strategy/setups'

const H = 3_600_000

/** What `SmcService.context()` returns: the same detectors as the chart and Claude analyst. */
export interface ScreenInput {
  symbol: string
  price: number
  priceT: number
  trend: Record<string, Dir | null>
  /** Active POIs (known, not invalidated). */
  pois: readonly Poi[]
  setups: readonly Setup[]
  lastBreak: Record<string, StructureBreak | null>
}

/**
 * Screens one symbol for entry material, per direction. A row needs an entry location (active
 * setup or nearby POI) or a recent BOS; trend alignment alone is only a flag/filter.
 */
export function screenSymbol(input: ScreenInput, cfg: ScreenerConfig, now: number): ScreenerRow[] {
  const { symbol, price } = input
  const rows: ScreenerRow[] = []
  const trend = { '4h': input.trend['4h'] ?? null, '1h': input.trend['1h'] ?? null, '15m': input.trend['15m'] ?? null }

  for (const dir of ['bullish', 'bearish'] as const) {
    const toRow = (x: Setup): ScreenerSetup => ({
      id: x.id,
      model: x.model,
      entry: x.entry,
      sl: x.sl,
      tp: x.tp,
      tpLiquidity: x.tpLiquidity,
      rr: x.rr,
      score: x.score,
      confluence: x.confluence,
      status: x.status as 'pending' | 'triggered',
      createdT: x.createdT,
      poi: { kind: x.poi.kind, timeframe: x.poi.timeframe, origin: x.poi.origin },
      child: { kind: x.child.kind, timeframe: x.child.timeframe },
      ...(x.expiryCandles !== undefined ? { expiryCandles: x.expiryCandles } : {})
    })
    const setups = input.setups
      .filter((x) => x.direction === dir && (x.status === 'pending' || x.status === 'triggered'))
      .sort((a, b) => b.createdT - a.createdT)
      .map(toRow)
    const setup = setups.reduce<ScreenerSetup | null>((a, b) => (a && (a.score > b.score || (a.score === b.score && a.createdT >= b.createdT)) ? a : b), null)

    // bullish POIs are bought from below price, bearish ones sold from above
    let nearPoi: ScreenerRow['nearPoi'] = null
    for (const p of input.pois) {
      if (p.direction !== dir || !(cfg.poiTimeframes as Timeframe[]).includes(p.timeframe)) continue
      if (dir === 'bullish' ? p.level > price : p.level < price) continue
      const distPct = (Math.abs(price - p.level) / price) * 100
      if (distPct > cfg.nearPoiPct || (nearPoi && nearPoi.distPct <= distPct)) continue
      nearPoi = { kind: p.kind, timeframe: p.timeframe, level: p.level, distPct }
    }

    let recentBos: ScreenerRow['recentBos'] = null
    for (const tf of cfg.bosTimeframes) {
      const b = input.lastBreak[tf]
      if (!b || b.direction !== dir) continue
      // known from the close of the breaking candle
      if (now - (b.t + TF_MS[tf]) > cfg.bosRecentHours * H) continue
      if (!recentBos || b.t > recentBos.t) recentBos = { timeframe: tf, level: b.level, t: b.t }
    }

    if (!setup && !nearPoi && !recentBos) continue
    const trendAligned = trend['4h'] === dir && trend['1h'] === dir && trend['15m'] === dir
    rows.push({ symbol, direction: dir, price, dataT: input.priceT, setup, setups, nearPoi, trendAligned, trend, recentBos })
  }
  return rows
}

/** Criteria met (setup, near POI, trend aligned, recent BOS). */
export const hitCount = (r: ScreenerRow): number => +!!r.setup + +!!r.nearPoi + +r.trendAligned + +!!r.recentBos

/** Active setups first, then most criteria, then closest POI. */
export function rankRows(rows: ScreenerRow[]): ScreenerRow[] {
  return [...rows].sort(
    (a, b) =>
      +!!b.setup - +!!a.setup ||
      hitCount(b) - hitCount(a) ||
      (a.nearPoi?.distPct ?? Infinity) - (b.nearPoi?.distPct ?? Infinity) ||
      a.symbol.localeCompare(b.symbol)
  )
}
