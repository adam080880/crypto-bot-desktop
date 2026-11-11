import { TF_MS, type DerivedTimeframe } from '@shared/timeframes'
import { CandleRepo } from '../db/candles'
import type { Db } from '../db/client'
import { symbolByName } from '../db/symbolsRepo'
import type { BinanceFuturesClient } from '../exchange/binanceFutures'

export interface VerifyResult {
  symbol: string
  timeframe: DerivedTimeframe
  compared: number
  ohlcMismatches: number
  maxVolumeRelDiff: number
  incomplete: number
  examples: string[]
}

/** Compare our resampled candles against Binance's native klines for the most recent window. */
export async function verifyResample(
  db: Db,
  client: BinanceFuturesClient,
  symbol: string,
  tf: DerivedTimeframe,
  count = 500
): Promise<VerifyResult> {
  const sym = symbolByName(db, symbol)
  if (!sym) throw new Error(`unknown symbol ${symbol}`)
  const repo = new CandleRepo(db)
  const ours = repo.latest(tf, sym.id, count) as { t: number; o: number; h: number; l: number; c: number; v: number; n: number }[]
  const res: VerifyResult = { symbol, timeframe: tf, compared: 0, ohlcMismatches: 0, maxVolumeRelDiff: 0, incomplete: 0, examples: [] }
  if (!ours.length) return res
  const native = new Map<number, { o: number; h: number; l: number; c: number; v: number }>()
  for await (const rows of client.klines(symbol, tf, ours[0]!.t, ours[ours.length - 1]!.t + TF_MS[tf])) {
    for (const r of rows) native.set(r.t, r)
  }
  const full = TF_MS[tf] / TF_MS['1m']
  for (const o of ours) {
    const n = native.get(o.t)
    if (!n) continue
    res.compared++
    if (o.n < full) res.incomplete++
    if (o.o !== n.o || o.h !== n.h || o.l !== n.l || o.c !== n.c) {
      res.ohlcMismatches++
      if (res.examples.length < 3)
        res.examples.push(`${new Date(o.t).toISOString()} ours=${o.o}/${o.h}/${o.l}/${o.c} n=${o.n} binance=${n.o}/${n.h}/${n.l}/${n.c}`)
    }
    if (n.v > 0) res.maxVolumeRelDiff = Math.max(res.maxVolumeRelDiff, Math.abs(o.v - n.v) / n.v)
  }
  return res
}
