import type { BacktestParams, BacktestResult, PeriodKey, ReactionRow } from '@shared/backtest'
import type { AppConfig } from '@shared/config'
import type { Db } from '../db/client'
import { SmcService } from '../strategy/service'
import { collectPois, detectSetups } from '../strategy/setups'
import { breakdown, byPeriod, funnel, poiTouch, reactionRows, simulateEquity, toTrades, tradeStats } from './engine'

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

/**
 * Backtest one symbol over all stored data with the same detectors as live (detectSetups), the
 * current SMC config, fees, and a bot-like equity run sized by risk % per trade.
 */
export function runBacktest(db: Db, params: BacktestParams, config: AppConfig): BacktestResult | null {
  const started = Date.now()
  const smc = new SmcService(db)
  const cfg = config.smc
  const h = smc.history(params.symbol, cfg)
  if (!h || h.entry.candles.length < 100) return null
  const c = h.entry.candles
  const dataFrom = c[0]!.t
  const dataTo = c.at(-1)!.t
  const { splitT, splitAdjusted } = splitTime(dataFrom, dataTo, params.oosDays)
  const full: Required<BacktestParams> = { ...params, riskPerTradePct: params.riskPerTradePct ?? config.bot.riskPerTradePct }

  // A. setups: POI hit → OB valid → limit entry, followed to TP / SL
  const setups = detectSetups({ symbol: params.symbol, entry: h.entry, poiAnalyses: h.poiAnalyses, cfg })
  const sp = byPeriod(setups, (s) => s.createdT, splitT)
  const trades = toTrades(setups, params)
  const tp = byPeriod(trades, (t) => t.setup.createdT, splitT)
  const gp = byPeriod(toTrades(setups, { makerFeePct: 0, takerFeePct: 0, slippagePct: 0 }), (t) => t.setup.createdT, splitT)
  const periods: PeriodKey[] = ['all', 'is', 'oos']

  // B. POI reaction, independent of the entry rule
  const pois = [...h.poiAnalyses.flatMap(collectPois), ...(cfg.sameTfPoi ? collectPois(h.entry) : [])].filter(
    (p) => p.activeFrom >= dataFrom && p.activeFrom <= dataTo
  )
  const touches = pois.map((p) => poiTouch(p, c, params.reactionHours * 3_600_000)).filter((x) => x !== null)
  const reactions: ReactionRow[] = reactionRows(pois, touches)

  return {
    symbol: params.symbol,
    ranAt: started,
    ms: Date.now() - started,
    dataFrom,
    dataTo,
    splitT,
    splitAdjusted,
    params: full,
    risk: { maxLeverage: config.risk.maxLeverage, maxDailyLossPct: config.risk.maxDailyLossPct },
    funnel: Object.fromEntries(periods.map((p) => [p, funnel(sp[p])])) as BacktestResult['funnel'],
    stats: Object.fromEntries(periods.map((p) => [p, tradeStats(tp[p])])) as BacktestResult['stats'],
    grossStats: Object.fromEntries(periods.map((p) => [p, tradeStats(gp[p])])) as BacktestResult['stats'],
    breakdown: breakdown(trades, splitT),
    equity: simulateEquity(trades, {
      startEquity: params.startEquity,
      riskPct: full.riskPerTradePct,
      maxLeverage: config.risk.maxLeverage,
      maxDailyLossPct: config.risk.maxDailyLossPct
    }),
    reactions,
    recent: [...trades]
      .sort((a, b) => b.exitT - a.exitT)
      .slice(0, 30)
      .map((t) => ({
        direction: t.setup.direction,
        poi: `${t.setup.poi.kind} ${t.setup.poi.timeframe}`,
        score: t.setup.score,
        entry: t.setup.entry,
        sl: t.setup.sl,
        tp: t.setup.tp,
        rr: t.setup.rr,
        filledT: t.filledT,
        exitT: t.exitT,
        r: t.r
      }))
  }
}
