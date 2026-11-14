import type { SmcConfig } from '@shared/config'
import type { Setup, SmcAnalysis } from '@shared/smc'
import type { Timeframe } from '@shared/timeframes'
import { CandleRepo } from '../db/candles'
import type { Db } from '../db/client'
import { symbolByName } from '../db/symbolsRepo'
import { analyzeSmc, toPublic, type SmcAnalysisFull } from './analyze'
import { collectPois, detectSetups, type Poi } from './setups'
import type { Dir } from '@shared/smc'

const ENTRY_LOOKBACK = 2000 // ≈ 21 days of 15m
const POI_LOOKBACK = 1000 // ≈ 166 days of 4h / 41 days of 1h

/** Thin DB adapter around the pure detectors (same functions the backtester will use). */
export class SmcService {
  private readonly repo: CandleRepo

  constructor(private readonly db: Db) {
    this.repo = new CandleRepo(db)
  }

  private analyzeFull(symbolId: number, tf: Timeframe, limit: number, cfg: SmcConfig): SmcAnalysisFull {
    return analyzeSmc(this.repo.latest(tf, symbolId, limit), tf, cfg)
  }

  analyze(symbol: string, tf: Timeframe, limit: number, cfg: SmcConfig): SmcAnalysis | null {
    const sym = symbolByName(this.db, symbol)
    if (!sym) return null
    return toPublic(this.analyzeFull(sym.id, tf, limit, cfg))
  }

  /**
   * SMC context used by trade-on-news candidates: trends per TF, active POIs, unswept swing
   * liquidity and current setups. Same detectors as everywhere else.
   */
  context(symbol: string, cfg: SmcConfig, now = Date.now()) {
    const sym = symbolByName(this.db, symbol)
    if (!sym) return null
    const tfs: Timeframe[] = ['15m', '1h', '4h']
    const analyses = tfs.map((tf) => this.analyzeFull(sym.id, tf, tf === '15m' ? ENTRY_LOOKBACK : POI_LOOKBACK, cfg))
    const last1m = this.repo.latest('1m', sym.id, 1)[0]
    const lastCandle = last1m ?? analyses[0]!.candles.at(-1)
    if (!lastCandle) return null
    const price = lastCandle.c
    const priceT = lastCandle.t
    const trend = Object.fromEntries(analyses.map((a) => [a.timeframe, a.trend])) as Record<string, Dir | null>
    const pois: Poi[] = analyses.flatMap(collectPois).filter((p) => p.invalidT === null && p.activeFrom <= now)
    const liquidity = analyses.flatMap((a) => a.liquidity.filter((l) => l.kind === 'swing' && l.sweptT === null))
    const entry = analyses[0]!
    const setups = detectSetups({ symbol, entry, poiAnalyses: analyses.slice(1), cfg })
    const lastBreak = Object.fromEntries(analyses.map((a) => [a.timeframe, a.breaks.at(-1) ?? null]))
    return { price, priceT, trend, pois, liquidity, setups, lastBreak }
  }

  /**
   * Every stored candle of the entry and POI timeframes, analysed once (backtest). The detectors
   * don't repaint, so analysing the whole history equals replaying it candle by candle.
   */
  history(symbol: string, cfg: SmcConfig): { entry: SmcAnalysisFull; poiAnalyses: SmcAnalysisFull[] } | null {
    const sym = symbolByName(this.db, symbol)
    if (!sym) return null
    const all = (tf: Timeframe): SmcAnalysisFull => analyzeSmc(this.repo.range(tf, sym.id, 0, Number.MAX_SAFE_INTEGER), tf, cfg)
    const entry = all(cfg.entryTimeframe)
    const poiAnalyses = cfg.poiTimeframes.filter((tf) => tf !== cfg.entryTimeframe).map(all)
    return { entry, poiAnalyses }
  }

  setups(symbol: string, cfg: SmcConfig): Setup[] {
    const sym = symbolByName(this.db, symbol)
    if (!sym) return []
    const entry = this.analyzeFull(sym.id, cfg.entryTimeframe, ENTRY_LOOKBACK, cfg)
    const pois = cfg.poiTimeframes
      .filter((tf) => tf !== cfg.entryTimeframe)
      .map((tf) => this.analyzeFull(sym.id, tf, POI_LOOKBACK, cfg))
    return detectSetups({ symbol, entry, poiAnalyses: pois, cfg })
  }
}
