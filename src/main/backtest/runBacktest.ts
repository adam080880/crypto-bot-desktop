import type { BacktestParams, BacktestProgress, BacktestResult, BtResult, BtSetup, ReactionRow } from '@shared/backtest'
import type { AppConfig } from '@shared/config'
import { ENTRY_MODELS } from '@shared/smc'
import { CandleRepo } from '../db/candles'
import type { Db } from '../db/client'
import { symbolByName } from '../db/symbolsRepo'
import { SmcService } from '../strategy/service'
import { collectAllPois, detectSetups } from '../strategy/setups'
import { poiTouch, reactionRows } from './engine'
import { defaultPlans, simulateSetup, type SimStatus } from './simulate'

const DAY = 86_400_000

/**
 * Out-of-sample = last `oosDays`. When the history is shorter than 3× that (e.g. a recently listed
 * coin), keep the same 2:1 ratio instead so both periods have data.
 */
export function splitTime(dataFrom: number, dataTo: number, oosDays: number): { splitT: number; splitAdjusted: boolean } {
  const span = dataTo - dataFrom
  if (span >= 3 * oosDays * DAY) return { splitT: dataTo - oosDays * DAY, splitAdjusted: false }
  return { splitT: dataFrom + Math.round((span * 2) / 3), splitAdjusted: true }
}

const CODE: Record<SimStatus, BtResult['s']> = { win: 'w', be: 'b', loss: 'l', open: 'o', missed: 'm', invalid: 'i', expired: 'e', pending: 'p' }

/**
 * Backtest v2 of one symbol over all stored data: every entry model (same detectors as live),
 * every exit plan side by side, fills and exits on stored 1m candles. The renderer filters the
 * per-setup results itself (no re-run for a different filter).
 */
export function runBacktest(db: Db, params: BacktestParams, config: AppConfig, onProgress?: (p: BacktestProgress) => void): BacktestResult | null {
  const started = Date.now()
  const progress = (stage: BacktestProgress['stage'], done = 0, total = 0): void => onProgress?.({ symbol: params.symbol, stage, done, total })
  progress('load')
  const smc = new SmcService(db)
  const cfg = { ...config.smc, models: [...ENTRY_MODELS] }
  const h = smc.history(params.symbol, cfg)
  if (!h || h.entry.candles.length < 100) return null
  const sym = symbolByName(db, params.symbol)!
  const c = h.entry.candles
  const minute = new CandleRepo(db).range('1m', sym.id, c[0]!.t, Number.MAX_SAFE_INTEGER)
  const dataFrom = c[0]!.t
  const dataTo = c.at(-1)!.t
  const { splitT, splitAdjusted } = splitTime(dataFrom, dataTo, params.oosDays)
  const full: Required<BacktestParams> = { ...params, riskPerTradePct: params.riskPerTradePct ?? config.bot.riskPerTradePct }
  const fees = { makerFeePct: params.makerFeePct, takerFeePct: params.takerFeePct, slippagePct: params.slippagePct }

  progress('detect')
  const detected = detectSetups({ symbol: params.symbol, entry: h.entry, poiAnalyses: h.poiAnalyses, cfg, exit: config.exit, btc: h.btc })
  const plans = defaultPlans(config.exit)
  const setups: BtSetup[] = []
  const sim = { entry: c, entryTf: cfg.entryTimeframe, minute, fees, expiry: cfg.setupExpiryCandles, slBufferPct: cfg.slBufferPct }
  detected.forEach((s, i) => {
    if (i % 100 === 0) progress('simulate', i, detected.length)
    setups.push({
      id: s.id,
      t: s.createdT,
      dir: s.direction,
      model: s.model,
      poiKind: s.poi.kind,
      poiTf: s.poi.timeframe,
      origin: s.poi.origin,
      childKind: s.child.kind,
      childTf: s.child.timeframe,
      score: s.score,
      conf: s.confluence,
      entry: s.entry,
      sl: s.sl,
      slPct: (Math.abs(s.entry - s.sl) / s.entry) * 100,
      tpLiquidity: s.tpLiquidity,
      res: plans.map((p) => {
        const r = simulateSetup(s, p, sim)
        return { s: CODE[r.status], f: r.filledT, x: r.exitT, r: Math.round(r.r * 1000) / 1000 }
      })
    })
  })

  // B. POI reaction, independent of the entry rule
  const pois = collectAllPois([h.entry, ...h.poiAnalyses], cfg).filter((p) => p.activeFrom >= dataFrom && p.activeFrom <= dataTo)
  const touches = pois.map((p) => poiTouch(p, c, params.reactionHours * 3_600_000)).filter((x) => x !== null)
  const reactions: ReactionRow[] = reactionRows(pois, touches)
  progress('done', detected.length, detected.length)

  return {
    version: 2,
    symbol: params.symbol,
    ranAt: started,
    ms: Date.now() - started,
    dataFrom,
    dataTo,
    splitT,
    splitAdjusted,
    minuteResolution: minute.length > 0,
    params: full,
    risk: { maxLeverage: config.risk.maxLeverage, maxDailyLossPct: config.risk.maxDailyLossPct },
    plans: plans.map(({ key, label, ...exit }) => ({ key, label, exit })),
    setups,
    reactions
  }
}
