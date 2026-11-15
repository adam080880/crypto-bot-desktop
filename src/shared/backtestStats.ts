/** Pure stats over Backtest v2 results (renderer filters + tests). No Node imports. */
import type { BtResult, BtSetup, PeriodKey } from './backtest'
import { poiConcept, type Confluence, type Dir, type EntryModel } from './smc'

export interface BtFilter {
  models: EntryModel[]
  dirs: Dir[]
  /** "OB|4h"; empty = any. */
  pois: string[]
  childKinds: string[]
  /** All must be present (SMC models M0–M4). */
  conf: Confluence[]
  /** All must be present (M5 trend). Optional for filters saved before M5. */
  trendConf?: Confluence[]
  minScore: number
}

/** Filter/profile key of the parent POI; M4 is "BREAKER|tf" (its parent OB got broken). */
export const poiKey = (s: Pick<BtSetup, 'model' | 'poiKind' | 'poiTf'>): string => `${poiConcept(s.model, s.poiKind)}|${s.poiTf}`

export function applyFilter(setups: readonly BtSetup[], f: BtFilter): BtSetup[] {
  return setups.filter(
    (s) =>
      (!f.models.length || f.models.includes(s.model)) &&
      (!f.dirs.length || f.dirs.includes(s.dir)) &&
      (!f.pois.length || f.pois.includes(poiKey(s))) &&
      (!f.childKinds.length || f.childKinds.includes(s.childKind)) &&
      // SMC models and M5 have separate required lists (same rule as the bot gate)
      (s.model === 'M5' ? (f.trendConf ?? []) : s.model === 'M6' ? [] : f.conf).every((k) => s.conf.includes(k)) &&
      s.score >= f.minScore
  )
}

export interface Stats {
  trades: number
  wins: number
  be: number
  losses: number
  winrate: number | null
  /** (wins + BE) ÷ trades. */
  noLoss: number | null
  avgR: number | null
  totalR: number
  profitFactor: number | null
  maxDdR: number
  /** Funnel of the setups (incl. ones that never traded). */
  setups: number
  missed: number
  expired: number
  invalid: number
  open: number
}

const closed = (r: BtResult): boolean => r.s === 'w' || r.s === 'b' || r.s === 'l'

export function stats(setups: readonly BtSetup[], plan: number): Stats {
  const rs = setups.map((s) => s.res[plan]!).filter(Boolean)
  const done = rs.filter(closed).sort((a, b) => a.x! - b.x!)
  let total = 0
  let gw = 0
  let gl = 0
  let peak = 0
  let dd = 0
  let wins = 0
  let be = 0
  for (const r of done) {
    if (r.s === 'w') wins++
    else if (r.s === 'b') be++
    total += r.r
    if (r.r > 0) gw += r.r
    else gl -= r.r
    peak = Math.max(peak, total)
    dd = Math.max(dd, peak - total)
  }
  const n = done.length
  return {
    trades: n,
    wins,
    be,
    losses: n - wins - be,
    winrate: n ? wins / n : null,
    noLoss: n ? (wins + be) / n : null,
    avgR: n ? total / n : null,
    totalR: total,
    profitFactor: gl > 0 ? gw / gl : null,
    maxDdR: dd,
    setups: rs.length,
    missed: rs.filter((r) => r.s === 'm').length,
    expired: rs.filter((r) => r.s === 'e').length,
    invalid: rs.filter((r) => r.s === 'i').length,
    open: rs.filter((r) => r.s === 'o' || r.s === 'p').length
  }
}

export function byPeriod(setups: readonly BtSetup[], splitT: number): Record<PeriodKey, BtSetup[]> {
  const out: Record<PeriodKey, BtSetup[]> = { all: [...setups], is: [], oos: [] }
  for (const s of setups) (s.t < splitT ? out.is : out.oos).push(s)
  return out
}

export interface MetaRow {
  key: string
  model: EntryModel
  poi: string
  plan: number
  is: Stats
  oos: Stats
  all: Stats
  /** Positive in both periods with enough trades. */
  robust: boolean
}

/**
 * "Meta" table: every (model × parent POI) combination under every plan, ranked by out-of-sample
 * avg R. A row is robust only when both periods are positive and in-sample has ≥ minTrades
 * (picking on in-sample and confirming out-of-sample is what keeps this from being curve fitting).
 */
export function metaTable(setups: readonly BtSetup[], plans: number, splitT: number, minTrades: number): MetaRow[] {
  const groups = new Map<string, BtSetup[]>()
  for (const s of setups) {
    const k = `${s.model}~${poiKey(s)}`
    groups.set(k, [...(groups.get(k) ?? []), s])
  }
  const rows: MetaRow[] = []
  for (const [k, list] of groups) {
    const [model, poi] = k.split('~') as [EntryModel, string]
    const p = byPeriod(list, splitT)
    for (let plan = 0; plan < plans; plan++) {
      const is = stats(p.is, plan)
      const oos = stats(p.oos, plan)
      const all = stats(p.all, plan)
      if (!all.trades) continue
      rows.push({ key: `${k}~${plan}`, model, poi, plan, is, oos, all, robust: is.trades >= minTrades && (is.avgR ?? 0) > 0 && (oos.avgR ?? 0) > 0 && oos.trades > 0 })
    }
  }
  return rows.sort((a, b) => +b.robust - +a.robust || (b.oos.avgR ?? -Infinity) - (a.oos.avgR ?? -Infinity) || b.all.trades - a.all.trades)
}

export interface EquityResult {
  endEquity: number
  returnPct: number
  maxDdPct: number
  taken: number
  skippedOpen: number
  skippedHalt: number
  leverageCapped: number
  maxLosingStreak: number
  curve: { t: number; equity: number }[]
}

/**
 * Bot-like equity run: risk `riskPct` of equity per trade (size = risk ÷ SL distance), notional
 * capped at maxLeverage × equity, one position at a time on the coin, no new entries for the rest
 * of the UTC day once that day's realised loss reaches maxDailyLossPct.
 */
export function simulateEquity(
  setups: readonly BtSetup[],
  plan: number,
  o: { startEquity: number; riskPct: number; maxLeverage: number; maxDailyLossPct: number }
): EquityResult {
  const trades = setups
    .map((s) => ({ s, r: s.res[plan]! }))
    .filter(({ r }) => r && closed(r))
    .sort((a, b) => a.r.f! - b.r.f! || a.r.x! - b.r.x!)
  let equity = o.startEquity
  let peak = equity
  let maxDdPct = 0
  let openUntil = -Infinity
  let taken = 0
  let skippedOpen = 0
  let skippedHalt = 0
  let leverageCapped = 0
  let streak = 0
  let maxLosingStreak = 0
  const dayStart = new Map<number, number>()
  const dayPnl = new Map<number, number>()
  const day = (t: number): number => Math.floor(t / 86_400_000)
  const curve: { t: number; equity: number }[] = [{ t: trades[0]?.r.f ?? 0, equity }]
  for (const { s, r } of trades) {
    if (r.f! <= openUntil) {
      skippedOpen++
      continue
    }
    const d = day(r.f!)
    if (!dayStart.has(d)) dayStart.set(d, equity)
    if ((dayPnl.get(d) ?? 0) <= -dayStart.get(d)! * (o.maxDailyLossPct / 100)) {
      skippedHalt++
      continue
    }
    const riskAmt = equity * (o.riskPct / 100)
    const notional = riskAmt / (s.slPct / 100)
    let scale = 1
    if (notional > equity * o.maxLeverage) {
      scale = (equity * o.maxLeverage) / notional
      leverageCapped++
    }
    const pnl = riskAmt * scale * r.r
    const e = day(r.x!)
    if (!dayStart.has(e)) dayStart.set(e, equity)
    dayPnl.set(e, (dayPnl.get(e) ?? 0) + pnl)
    equity += pnl
    taken++
    openUntil = r.x!
    streak = pnl < 0 ? streak + 1 : 0
    maxLosingStreak = Math.max(maxLosingStreak, streak)
    peak = Math.max(peak, equity)
    maxDdPct = Math.max(maxDdPct, ((peak - equity) / peak) * 100)
    curve.push({ t: r.x!, equity })
  }
  const step = Math.max(1, Math.ceil(curve.length / 600))
  return {
    endEquity: equity,
    returnPct: ((equity - o.startEquity) / o.startEquity) * 100,
    maxDdPct,
    taken,
    skippedOpen,
    skippedHalt,
    leverageCapped,
    maxLosingStreak,
    curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1)
  }
}

/** Group closed trades of one plan by a key (breakdown table). */
export function breakdown(setups: readonly BtSetup[], plan: number, splitT: number, keyOf: (s: BtSetup) => string): { key: string; all: Stats; is: Stats; oos: Stats }[] {
  const groups = new Map<string, BtSetup[]>()
  for (const s of setups) {
    const k = keyOf(s)
    groups.set(k, [...(groups.get(k) ?? []), s])
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const p = byPeriod(list, splitT)
      return { key, all: stats(p.all, plan), is: stats(p.is, plan), oos: stats(p.oos, plan) }
    })
    .filter((g) => g.all.trades > 0)
    .sort((a, b) => b.all.trades - a.all.trades)
}
