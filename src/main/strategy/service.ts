import type { SmcConfig } from '@shared/config'
import type { Setup, SmcAnalysis } from '@shared/smc'
import type { Timeframe } from '@shared/timeframes'
import { CandleRepo } from '../db/candles'
import type { Db } from '../db/client'
import { symbolByName } from '../db/symbolsRepo'
import { analyzeSmc, toPublic, type SmcAnalysisFull } from './analyze'
import { collectAllPois, detectSetups, type Poi, type SetupInput } from './setups'
import { liquidityPools, poiStory } from './story'
import { InducementIndex } from './inducement'
import type { StoryResult } from '@shared/story'
import { TF_MS } from '@shared/timeframes'
import { FlowRepo } from '../flow/flowRepo'
import type { FlowData } from './flow'
import type { ExitConfig } from '@shared/config'
import type { Dir } from '@shared/smc'
import type { Candle } from '@shared/candles'
import { btcDomFeed } from '../flow/btcDom'

const ENTRY_LOOKBACK = 2000 // ≈ 21 days of 15m
const POI_LOOKBACK = 1000 // ≈ 166 days of 4h / 41 days of 1h

/** Thin DB adapter around the pure detectors (same functions the backtester will use). */
const BTC = 'BTCUSDT'
const ETH = 'ETHUSDT'
const BTC_CACHE_MS = 30_000

/** Timeframes analysed for setups: entry + POI timeframes (+1d for origin checks, + the M5 trend TF). */
export function setupTimeframes(cfg: SmcConfig): Timeframe[] {
  return [...new Set<Timeframe>([cfg.entryTimeframe, ...cfg.poiTimeframes, '1d', cfg.trendTimeframe, ...(cfg.models.includes('M6') ? (['1h'] as const) : []), ...(cfg.models.includes('M7') ? [cfg.msnrTimeframe] : []), ...(cfg.models.includes('M8') ? cfg.m8PoiTimeframes : []), ...(cfg.models.includes('M9') ? cfg.m9PoiTimeframes : [])])]
}

export class SmcService {
  private readonly repo: CandleRepo
  private btcCache: { at: number; v: SetupInput['btc'] } | null = null
  private ethCache: { at: number; v: readonly Candle[] | undefined } | null = null
  private readonly flowRepo: FlowRepo

  constructor(private readonly db: Db) {
    this.repo = new CandleRepo(db)
    this.flowRepo = new FlowRepo(db)
  }

  /** Stored open interest / funding (undefined when the tables don't exist yet, e.g. read-only DB before migration). */
  private flow(symbolId: number): FlowData | undefined {
    try {
      return this.flowRepo.get(symbolId)
    } catch {
      return undefined
    }
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
  /** BTC 4h/1h trend for the setup score (cached briefly: the screener asks once per symbol). */
  btcTrend(cfg: SmcConfig, now = Date.now()): SetupInput['btc'] {
    if (this.btcCache && now - this.btcCache.at < BTC_CACHE_MS) return this.btcCache.v
    const sym = symbolByName(this.db, BTC)
    const v = sym
      ? { '4h': this.analyzeFull(sym.id, '4h', POI_LOOKBACK, cfg), '1h': this.analyzeFull(sym.id, '1h', POI_LOOKBACK, cfg) }
      : undefined
    this.btcCache = { at: now, v }
    return v
  }

  /** 1h candles of the SMT reference: BTC for alts (shares the BTC trend cache), ETH for BTC. */
  smtRef(symbol: string, cfg: SmcConfig, now = Date.now()): readonly Candle[] | undefined {
    if (symbol !== BTC) return (this.btcTrend(cfg, now)?.['1h'] as SmcAnalysisFull | undefined)?.candles
    if (this.ethCache && now - this.ethCache.at < BTC_CACHE_MS) return this.ethCache.v
    const eth = symbolByName(this.db, ETH)
    const v = eth ? this.repo.latest('1h', eth.id, POI_LOOKBACK) : undefined
    this.ethCache = { at: now, v }
    return v
  }

  /** Recent 1m / 5m candles for M10 (QM confirmation on lower timeframes); only when M10 is detected. */
  private ltf(symbolId: number, cfg: SmcConfig): SetupInput['ltf'] {
    if (!cfg.models.includes('M10')) return undefined
    const need = new Set(cfg.m10Timeframes)
    const n1 = Math.min(5000, cfg.m10WindowMin + 1500) // window + ~1 day of 1m
    return {
      ...(need.has('1m') ? { '1m': this.repo.latest('1m', symbolId, n1) } : {}),
      ...(need.has('3m') ? { '3m': this.repo.latest('3m', symbolId, Math.ceil(n1 / 3) + 300) } : {}),
      ...(need.has('5m') ? { '5m': this.repo.latest('5m', symbolId, Math.ceil(n1 / 5) + 300) } : {}),
      ...(need.has('10m') ? { '10m': this.repo.latest('10m', symbolId, Math.ceil(n1 / 10) + 300) } : {})
    }
  }

  /**
   * POI anatomy + liquidity draw (docs/smc-rules.md §12) for the chart: active POIs (≥ 1h, not plain OCL) nearest to the
   * price on each side (bullish below, bearish above, within 15 %), plus the parents of pending setups.
   */
  stories(symbol: string, cfg: SmcConfig, now = Date.now()): StoryResult | null {
    const sym = symbolByName(this.db, symbol)
    if (!sym) return null
    const tfs: Timeframe[] = ['15m', '1h', '4h', '1d']
    const all = tfs.map((tf) => this.analyzeFull(sym.id, tf, tf === '15m' ? ENTRY_LOOKBACK : POI_LOOKBACK, cfg))
    const last = this.repo.latest('1m', sym.id, 1)[0] ?? all[0]!.candles.at(-1)
    if (!last) return null
    const price = last.c
    const at = Math.min(now, last.t + 60_000)
    const pois = collectAllPois(all, cfg)
    const active = pois.filter((p) => p.activeFrom <= at && (p.invalidT === null || p.invalidT + TF_MS[p.timeframe] > at))
    const pick = (dir: 'bullish' | 'bearish'): Poi[] =>
      active
        .filter((p) => p.direction === dir && p.kind !== 'OCL' && TF_MS[p.timeframe] >= TF_MS['1h'] && (dir === 'bullish' ? p.level <= price : p.level >= price) && Math.abs(p.level / price - 1) <= 0.15)
        .sort((x, y) => Math.abs(x.level - price) - Math.abs(y.level - price))
        .slice(0, 5)
    const pools = liquidityPools(all, at)
    const idx = new InducementIndex(all[0]!, all, pois, { baitDays: cfg.baitDays, windowAtr: cfg.idmWindowAtr })
    const btc = symbol === BTC ? undefined : this.btcTrend(cfg, now)?.['4h']
    const ctx = { at, price, pois: active, allPois: pois, originNearPct: cfg.originNearPct, pools, btc4h: btc, idx, pdTimeframe: cfg.pdTimeframe, pdLookback: cfg.pdLookback }
    const stories = [...pick('bullish'), ...pick('bearish')]
      .map((p) => poiStory(p, all, ctx))
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((x, y) => Math.abs(x.distPct) - Math.abs(y.distPct))
    const strongest = (side: 'buy' | 'sell') =>
      pools
        .filter((p) => p.side === side && (side === 'buy' ? p.price > price : p.price < price))
        .sort((x, y) => y.weight / (Math.abs(y.price / price - 1) + 0.002) - x.weight / (Math.abs(x.price / price - 1) + 0.002))
        .slice(0, 5)
    return { symbol, price, at, stories, pools: { buy: strongest('buy'), sell: strongest('sell') } }
  }

  context(symbol: string, cfg: SmcConfig, now = Date.now(), exit?: ExitConfig) {
    const sym = symbolByName(this.db, symbol)
    if (!sym) return null
    const tfs: Timeframe[] = ['15m', '1h', '4h', '1d']
    const analyses = tfs.map((tf) => this.analyzeFull(sym.id, tf, tf === '15m' ? ENTRY_LOOKBACK : POI_LOOKBACK, cfg))
    const last1m = this.repo.latest('1m', sym.id, 1)[0]
    const lastCandle = last1m ?? analyses[0]!.candles.at(-1)
    if (!lastCandle) return null
    const price = lastCandle.c
    const priceT = lastCandle.t
    const trend = Object.fromEntries(analyses.map((a) => [a.timeframe, a.trend])) as Record<string, Dir | null>
    const pois: Poi[] = collectAllPois(analyses, cfg).filter((p) => p.invalidT === null && p.activeFrom <= now)
    const liquidity = analyses.flatMap((a) => a.liquidity.filter((l) => l.kind === 'swing' && l.sweptT === null))
    const entry = analyses[0]!
    const setups = detectSetups({ symbol, entry, poiAnalyses: analyses.slice(1), cfg, exit, btc: this.btcTrend(cfg, now), flow: this.flow(sym.id), btcDom: btcDomFeed.get(cfg, now), smtRef: this.smtRef(symbol, cfg, now), ltf: this.ltf(sym.id, cfg) })
    const lastBreak = Object.fromEntries(analyses.map((a) => [a.timeframe, a.breaks.at(-1) ?? null]))
    return { price, priceT, trend, pois, liquidity, setups, lastBreak }
  }

  /**
   * Every stored candle of the entry and POI timeframes, analysed once (backtest). The detectors
   * don't repaint, so analysing the whole history equals replaying it candle by candle.
   * `btcDom` = BTCDOMUSDT candles of smc.btcDomTimeframe for the btcDom tag (downloaded by the caller).
   */
  history(symbol: string, cfg: SmcConfig, btcDom?: readonly Candle[]): { entry: SmcAnalysisFull; poiAnalyses: SmcAnalysisFull[]; btc: SetupInput['btc']; btcDom?: SmcAnalysisFull; smtRef?: readonly Candle[]; ltf?: SetupInput['ltf'] } | null {
    const sym = symbolByName(this.db, symbol)
    if (!sym) return null
    const full = (id: number, tf: Timeframe): SmcAnalysisFull => analyzeSmc(this.repo.range(tf, id, 0, Number.MAX_SAFE_INTEGER), tf, cfg)
    const entry = full(sym.id, cfg.entryTimeframe)
    const poiAnalyses = setupTimeframes(cfg)
      .filter((tf) => tf !== cfg.entryTimeframe)
      .map((tf) => full(sym.id, tf))
    const btcSym = symbol === BTC ? sym : symbolByName(this.db, BTC)
    const btc = btcSym
      ? symbol === BTC
        ? { '4h': poiAnalyses.find((a) => a.timeframe === '4h') ?? full(btcSym.id, '4h'), '1h': poiAnalyses.find((a) => a.timeframe === '1h') ?? full(btcSym.id, '1h') }
        : { '4h': full(btcSym.id, '4h'), '1h': full(btcSym.id, '1h') }
      : undefined
    const eth = symbol === BTC ? symbolByName(this.db, ETH) : null
    const smtRef = symbol === BTC ? (eth ? this.repo.range('1h', eth.id, 0, Number.MAX_SAFE_INTEGER) : undefined) : (btc?.['1h'] as SmcAnalysisFull | undefined)?.candles
    const ltf: SetupInput['ltf'] = cfg.models.includes('M10')
      ? {
          ...(cfg.m10Timeframes.some((x) => x === '1m' || x === '3m') ? { '1m': this.repo.range('1m', sym.id, 0, Number.MAX_SAFE_INTEGER) } : {}),
          ...(cfg.m10Timeframes.includes('3m') ? { '3m': this.repo.range('3m', sym.id, 0, Number.MAX_SAFE_INTEGER) } : {}),
          ...(cfg.m10Timeframes.includes('5m') ? { '5m': this.repo.range('5m', sym.id, 0, Number.MAX_SAFE_INTEGER) } : {}),
          ...(cfg.m10Timeframes.includes('10m') ? { '10m': this.repo.range('10m', sym.id, 0, Number.MAX_SAFE_INTEGER) } : {})
        }
      : undefined
    return { entry, poiAnalyses, btc, btcDom: btcDom?.length ? analyzeSmc(btcDom, cfg.btcDomTimeframe, cfg) : undefined, smtRef, ltf }
  }

  setups(symbol: string, cfg: SmcConfig, exit?: ExitConfig): Setup[] {
    const sym = symbolByName(this.db, symbol)
    if (!sym) return []
    const entry = this.analyzeFull(sym.id, cfg.entryTimeframe, ENTRY_LOOKBACK, cfg)
    const pois = setupTimeframes(cfg)
      .filter((tf) => tf !== cfg.entryTimeframe)
      .map((tf) => this.analyzeFull(sym.id, tf, POI_LOOKBACK, cfg))
    return detectSetups({ symbol, entry, poiAnalyses: pois, cfg, exit, btc: this.btcTrend(cfg), flow: this.flow(sym.id), btcDom: btcDomFeed.get(cfg), smtRef: this.smtRef(symbol, cfg), ltf: this.ltf(sym.id, cfg) })
  }
}
