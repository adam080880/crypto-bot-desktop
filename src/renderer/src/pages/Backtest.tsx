import { useEffect, useMemo, useState } from 'react'
import { CandlestickChart, ChevronDown, ChevronRight, FlaskConical, Play, Star, Trash2 } from 'lucide-react'
import type { BacktestProgress, BacktestResult, BtSetup, CoinProfile, PeriodKey } from '@shared/backtest'
import { applyFilter, breakdown, byPeriod, metaTable, poiKey, simulateEquity, stats, type BtFilter, type Stats } from '@shared/backtestStats'
import type { SymbolListItem } from '@shared/ipc'
import { ENTRY_MODELS, MODEL_LABEL, POI_LABEL, type Confluence, type EntryModel, type PoiKind } from '@shared/smc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { cn, formatTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

const px = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))
const pct = (x: number | null, d = 0): string => (x === null ? '—' : `${(x * 100).toFixed(d)}%`)
const num = (x: number | null, d = 2): string => (x === null ? '—' : x.toFixed(d))
const signCls = (x: number | null): string => (x === null ? '' : x > 0 ? 'text-bull' : x < 0 ? 'text-bear' : '')
const day = (t: number): string => new Date(t).toISOString().slice(0, 10)

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'all', label: 'Semua' },
  { key: 'is', label: 'In-sample' },
  { key: 'oos', label: 'Out-of-sample' }
]
const CONF_CHIPS: { key: Confluence; label: string }[] = [
  { key: 'fvg', label: 'FVG' },
  { key: 'trendParent', label: 'searah trend POI' },
  { key: 'sweep', label: 'sweep' },
  { key: 'htfParent', label: 'POI HTF' },
  { key: 'btc4h', label: 'BTC 4h searah' },
  { key: 'btc1h', label: 'BTC 1h searah' },
  { key: 'wyckoff', label: 'Wyckoff searah' },
  { key: 'manipulation', label: 'spring/UTAD' },
  { key: 'unicorn', label: 'unicorn' },
  { key: 'equalLiq', label: 'equal H/L' }
]
const GROUPS: { key: string; label: string; of: (s: BtSetup) => string }[] = [
  { key: 'model', label: 'Model', of: (s) => s.model },
  { key: 'poi', label: 'POI induk', of: (s) => `${POI_LABEL[s.poiKind]} ${s.poiTf}` },
  { key: 'child', label: 'POI anak', of: (s) => `${s.childKind} ${s.childTf}` },
  { key: 'origin', label: 'Asal POI', of: (s) => s.origin ?? 'tanpa asal' },
  { key: 'score', label: 'Skor', of: (s) => String(s.score).padStart(2, '0') },
  { key: 'btc', label: 'Trend BTC', of: (s) => (s.conf.includes('btc4h') ? 'searah BTC 4h' : s.conf.includes('btcAgainst') ? 'lawan BTC' : 'campur') },
  { key: 'wyckoff', label: 'Wyckoff', of: (s) => (s.conf.includes('manipulation') ? 'searah + spring/UTAD' : s.conf.includes('wyckoff') ? 'searah' : s.conf.includes('wyckoffAgainst') ? 'berlawanan' : 'tidak ada') },
  { key: 'dir', label: 'Arah', of: (s) => (s.dir === 'bullish' ? 'long' : 'short') }
]
const STATUS_LABEL: Record<string, string> = { w: 'TP/profit', b: 'BE', l: 'SL', o: 'masih jalan' }
const DEFAULT_FILTER: BtFilter = { models: ['M1', 'M2b', 'M4'], dirs: [], pois: [], childKinds: [], conf: ['fvg', 'trendParent'], minScore: 0 }

interface Form {
  oosDays: number
  makerFeePct: number
  takerFeePct: number
  slippagePct: number
  startEquity: number
  riskPerTradePct: number
  reactionHours: number
}

const recall = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k)
    return v === null ? d : (JSON.parse(v) as T)
  } catch {
    return d
  }
}
const remember = (k: string, v: unknown): void => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}
const recallRaw = (k: string, d: string): string => {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}

// last result per symbol while the app runs (page switches unmount the component)
const cache = new Map<string, BacktestResult>()

/** Open the chart at a backtest trade (Chart reads `chart.focus` once). */
function openOnChart(symbol: string, s: BtSetup, exitT: number | null): void {
  try {
    localStorage.setItem('chart.symbol', symbol)
    localStorage.setItem('chart.tf', '15m')
    localStorage.setItem('chart.focus', JSON.stringify({ symbol, t: s.t, until: exitT ?? s.t, entry: s.entry, sl: s.sl, dir: s.dir }))
  } catch {
    /* storage unavailable */
  }
  useAppStore.getState().setPage('chart')
}

export function Backtest() {
  const [symbols, setSymbols] = useState<SymbolListItem[]>([])
  const [symbol, setSymbol] = useState(() => recall('backtest.symbol', recallRaw('chart.symbol', 'BTCUSDT')))
  const [query, setQuery] = useState(symbol)
  const [form, setForm] = useState<Form | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(cache.get(symbol) ?? null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<BacktestProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'ringkasan' | 'meta' | 'trade' | 'reaksi'>(() => recall('backtest.tab', 'ringkasan'))
  const [filter, setFilter] = useState<BtFilter>(() => ({ ...DEFAULT_FILTER, ...recall<Partial<BtFilter>>('backtest.filter', {}) }))
  const [planKey, setPlanKey] = useState<string>(() => recall('backtest.plan', 'r1'))
  const [profiles, setProfiles] = useState<Record<string, CoinProfile>>({})

  useEffect(() => {
    void window.api.invoke('symbols:list').then((l) => setSymbols(l.filter((s) => s.synced)))
    void window.api.invoke('backtest:profiles').then(setProfiles)
    void window.api.invoke('config:get').then((cfg) =>
      setForm({
        oosDays: 60,
        makerFeePct: 0.02,
        takerFeePct: 0.05,
        slippagePct: 0.02,
        startEquity: 10,
        reactionHours: 24,
        ...recall<Partial<Form>>('backtest.form', {}),
        riskPerTradePct: cfg.bot.riskPerTradePct
      })
    )
    return window.api.on('backtest:progress', setProgress)
  }, [])

  useEffect(() => remember('backtest.filter', filter), [filter])
  useEffect(() => remember('backtest.plan', planKey), [planKey])
  useEffect(() => remember('backtest.tab', tab), [tab])

  const pick = (s: string): void => {
    const sym = s.trim().toUpperCase()
    if (!symbols.some((x) => x.symbol === sym)) return
    setSymbol(sym)
    setQuery(sym)
    remember('backtest.symbol', sym)
    setResult(cache.get(sym) ?? null)
    setError(null)
  }

  const run = async (): Promise<void> => {
    if (!form) return
    setRunning(true)
    setError(null)
    setProgress(null)
    remember('backtest.form', { ...form, riskPerTradePct: undefined })
    try {
      const r = await window.api.invoke('backtest:run', { symbol, ...form })
      if (!r) setError(`Data ${symbol} belum cukup (butuh histori 15m/1h/4h).`)
      else {
        cache.set(symbol, r)
        setResult(r)
      }
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setRunning(false)
    }
  }

  const field = (k: keyof Form, label: string, step: number, suffix = '') =>
    form && (
      <label className="flex items-center gap-2">
        {label}
        <Input type="number" step={step} className="num h-7 w-20 text-right" value={form[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
        {suffix}
      </label>
    )

  const profile = profiles[symbol] ?? null
  const r = result && result.symbol === symbol && result.version === 2 ? result : null
  const planIdx = Math.max(0, r?.plans.findIndex((p) => p.key === planKey) ?? 0)
  const stage = progress?.symbol === symbol ? progress : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <FlaskConical className="size-5" />
        <h1 className="text-lg font-semibold">Backtest</h1>
        <Input
          list="bt-symbols"
          className="num h-8 w-40 uppercase"
          value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && pick(query)}
          onBlur={() => pick(query)}
          aria-label="Koin"
        />
        <datalist id="bt-symbols">
          {symbols.map((s) => (
            <option key={s.symbol} value={s.symbol} />
          ))}
        </datalist>
        <Button size="sm" disabled={!form || running} onClick={() => void run()}>
          <Play className="size-4" /> {running ? 'Menghitung…' : `Jalankan ${symbol}`}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowForm(!showForm)}>
          {showForm ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Fee & periode
        </Button>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => {
          try {
            localStorage.setItem('chart.symbol', symbol)
          } catch {
            /* ignore */
          }
          useAppStore.getState().setPage('chart')
        }}>
          <CandlestickChart className="size-4" /> Buka {symbol} di Chart
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-4 text-xs text-muted-foreground">
            {field('oosDays', 'Out-of-sample', 1, 'hari terakhir')}
            {field('makerFeePct', 'Fee maker', 0.01, '%')}
            {field('takerFeePct', 'Fee taker', 0.01, '%')}
            {field('slippagePct', 'Slippage stop', 0.01, '%')}
            {field('startEquity', 'Modal awal', 1, 'USDT')}
            {field('riskPerTradePct', 'Risk / order', 0.1, '% equity')}
            {field('reactionHours', 'Jendela reaksi POI', 1, 'jam')}
            <span>Risk default dari Settings → Bot; di sini cuma buat simulasi.</span>
          </CardContent>
        </Card>
      )}

      {running && (
        <div className="space-y-1">
          <Progress value={stage && stage.total ? (stage.done / stage.total) * 100 : stage?.stage === 'detect' ? 10 : 3} />
          <p className="text-xs text-muted-foreground">
            {stage?.stage === 'simulate'
              ? `Simulasi exit di candle 1m: ${stage.done}/${stage.total} setup`
              : stage?.stage === 'detect'
                ? 'Deteksi setup semua model…'
                : 'Memuat candle…'}
          </p>
        </div>
      )}
      {error && <p className="text-xs text-bear">{error}</p>}

      {profile && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 pt-4 text-xs">
            <Star className="size-4 text-warn" />
            <span className="font-medium">Profil bot untuk {symbol}:</span>
            <span>
              {profile.models.join(', ')} · POI {profile.pois.length ? profile.pois.map((p) => p.replace('|', ' ')).join(', ') : 'semua'} · {profile.plan.label}
              {profile.requireConfluence.length ? ` · wajib ${profile.requireConfluence.join(' + ')}` : ''}
            </span>
            <span className="num text-muted-foreground">
              {profile.stats.trades} trade · WR {pct(profile.stats.winrate)} · {num(profile.stats.avgR)}R · OOS {profile.stats.oosTrades} trade {num(profile.stats.oosAvgR)}R · disimpan {formatTime(profile.savedAt)}
            </span>
            <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => void window.api.invoke('backtest:deleteProfile', { symbol }).then(setProfiles)}>
              <Trash2 className="size-3.5" /> Hapus profil
            </Button>
          </CardContent>
        </Card>
      )}

      {r ? (
        <Results
          r={r}
          filter={filter}
          setFilter={setFilter}
          planIdx={planIdx}
          setPlanKey={setPlanKey}
          tab={tab}
          setTab={setTab}
          startEquity={form?.startEquity ?? r.params.startEquity}
          riskPct={form?.riskPerTradePct ?? r.params.riskPerTradePct}
          onSaveProfile={(p) => void window.api.invoke('backtest:saveProfile', p).then(setProfiles)}
        />
      ) : (
        !running && <p className="text-sm text-muted-foreground">Pilih koin lalu Jalankan. Semua model × semua rencana exit dihitung sekali; filter di bawah langsung berlaku tanpa jalan ulang.</p>
      )}
    </div>
  )
}

function Chips<T extends string>({ options, value, onChange, label }: { options: { key: T; label: string }[]; value: T[]; onChange: (v: T[]) => void; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      {options.map((o) => {
        const on = value.includes(o.key)
        return (
          <button
            key={o.key}
            type="button"
            className={cn('rounded-md border px-2 py-0.5', on ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            onClick={() => onChange(on ? value.filter((x) => x !== o.key) : [...value, o.key])}
          >
            {o.label}
          </button>
        )
      })}
      {value.length > 0 && (
        <button type="button" className="px-1 text-muted-foreground underline decoration-dotted" onClick={() => onChange([])}>
          reset
        </button>
      )}
    </div>
  )
}

function Results(p: {
  r: BacktestResult
  filter: BtFilter
  setFilter: (f: BtFilter) => void
  planIdx: number
  setPlanKey: (k: string) => void
  tab: 'ringkasan' | 'meta' | 'trade' | 'reaksi'
  setTab: (t: 'ringkasan' | 'meta' | 'trade' | 'reaksi') => void
  startEquity: number
  riskPct: number
  onSaveProfile: (p: CoinProfile) => void
}) {
  const { r, filter, setFilter, planIdx } = p
  const filtered = useMemo(() => applyFilter(r.setups, filter), [r, filter])
  const poiOptions = useMemo(
    () =>
      [...new Set(r.setups.map(poiKey))]
        .sort()
        .map((k) => ({ key: k, label: `${POI_LABEL[k.split('|')[0] as PoiKind]} ${k.split('|')[1]}` })),
    [r]
  )
  const childOptions = useMemo(() => [...new Set(r.setups.map((s) => s.childKind))].map((k) => ({ key: k, label: k })), [r])
  const plan = r.plans[planIdx]!

  return (
    <>
      <p className="text-xs text-muted-foreground">
        Data {day(r.dataFrom)} → {day(r.dataTo)} · in-sample s/d {day(r.splitT)}
        {r.splitAdjusted && ' (histori pendek → dibagi 2:1)'} · {r.setups.length} setup terdeteksi · exit disimulasikan di {r.minuteResolution ? 'candle 1m' : 'candle 15m (1m belum ada)'} · fee maker{' '}
        {r.params.makerFeePct}% / taker {r.params.takerFeePct}% + slippage {r.params.slippagePct}% · {formatTime(r.ranAt)}, {(r.ms / 1000).toFixed(1)} dtk
      </p>

      <Card>
        <CardContent className="space-y-1.5 pt-4 text-xs">
          <Chips label="Model" options={ENTRY_MODELS.map((m) => ({ key: m, label: m }))} value={filter.models} onChange={(models) => setFilter({ ...filter, models: models as EntryModel[] })} />
          <Chips label="Arah" options={[{ key: 'bullish', label: 'long' }, { key: 'bearish', label: 'short' }]} value={filter.dirs} onChange={(dirs) => setFilter({ ...filter, dirs })} />
          <Chips label="POI induk" options={poiOptions} value={filter.pois} onChange={(pois) => setFilter({ ...filter, pois })} />
          <Chips label="Entry di" options={childOptions} value={filter.childKinds} onChange={(childKinds) => setFilter({ ...filter, childKinds })} />
          <Chips label="Wajib ada" options={CONF_CHIPS} value={filter.conf} onChange={(conf) => setFilter({ ...filter, conf })} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 shrink-0 text-muted-foreground">Skor min</span>
            <Input type="number" className="num h-7 w-16 text-right" value={filter.minScore} onChange={(e) => setFilter({ ...filter, minScore: Number(e.target.value) || 0 })} />
            <span className="ml-4 text-muted-foreground">Exit</span>
            <select className="h-7 rounded-md border bg-background px-2" value={plan.key} onChange={(e) => p.setPlanKey(e.target.value)}>
              {r.plans.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
            <span className="ml-auto text-muted-foreground">{filtered.length} setup lolos filter</span>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-1 border-b">
        {(['ringkasan', 'meta', 'trade', 'reaksi'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={cn('-mb-px border-b-2 px-3 py-1.5 text-sm capitalize', p.tab === t ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}
            onClick={() => p.setTab(t)}
          >
            {t === 'reaksi' ? 'Reaksi POI' : t === 'meta' ? 'Meta (kombinasi terbaik)' : t}
          </button>
        ))}
      </div>

      {p.tab === 'ringkasan' && <Summary r={r} setups={filtered} planIdx={planIdx} setPlanKey={p.setPlanKey} startEquity={p.startEquity} riskPct={p.riskPct} />}
      {p.tab === 'meta' && <Meta r={r} setups={applyFilter(r.setups, { ...filter, models: [], pois: [] })} filter={filter} onSave={p.onSaveProfile} />}
      {p.tab === 'trade' && <Trades r={r} setups={filtered} planIdx={planIdx} />}
      {p.tab === 'reaksi' && <ReactionCard r={r} />}
    </>
  )
}

function StatsRow({ label, s, strong }: { label: string; s: Stats; strong?: boolean }) {
  return (
    <tr className="border-b text-right last:border-0">
      <td className="py-1.5 text-left font-medium">{label}</td>
      <td>{s.setups}</td>
      <td title="TP kena duluan sebelum limit entry → batal">{s.missed}</td>
      <td>{s.trades}</td>
      <td>{pct(s.winrate)}</td>
      <td title="menang + BE">{pct(s.noLoss)}</td>
      <td className={cn(strong && 'font-semibold', signCls(s.avgR))}>{num(s.avgR)}</td>
      <td className={signCls(s.totalR)}>{num(s.totalR, 1)}</td>
      <td>{num(s.profitFactor)}</td>
      <td className="text-bear">{num(s.maxDdR, 1)}R</td>
    </tr>
  )
}

const STATS_HEAD = (
  <tr className="border-b text-right">
    <th className="py-1 text-left">Periode</th>
    <th>Setup</th>
    <th>Lewat TP</th>
    <th>Trade</th>
    <th>WR</th>
    <th>Nggak rugi</th>
    <th>Avg R</th>
    <th>Total R</th>
    <th>PF</th>
    <th>Max DD</th>
  </tr>
)

function Summary({ r, setups, planIdx, setPlanKey, startEquity, riskPct }: { r: BacktestResult; setups: BtSetup[]; planIdx: number; setPlanKey: (k: string) => void; startEquity: number; riskPct: number }) {
  const [group, setGroup] = useState(GROUPS[0]!.key)
  const per = useMemo(() => byPeriod(setups, r.splitT), [setups, r.splitT])
  const plans = useMemo(() => r.plans.map((x, i) => ({ x, all: stats(setups, i), oos: stats(per.oos, i) })), [r.plans, setups, per])
  const rows = useMemo(() => breakdown(setups, planIdx, r.splitT, GROUPS.find((g) => g.key === group)!.of), [setups, planIdx, r.splitT, group])
  const eq = useMemo(() => simulateEquity(setups, planIdx, { startEquity, riskPct, maxLeverage: r.risk.maxLeverage, maxDailyLossPct: r.risk.maxDailyLossPct }), [setups, planIdx, startEquity, riskPct, r.risk])

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{r.plans[planIdx]!.label}</CardTitle>
          <CardDescription>R setelah fee. Avg R &gt; 0 di in-sample DAN out-of-sample = ada edge. WR "nggak rugi" = menang + break-even (exit bertingkat banyak keluar di BE).</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="num w-full text-xs">
            <thead className="text-muted-foreground">{STATS_HEAD}</thead>
            <tbody>
              {PERIODS.map(({ key, label }) => (
                <StatsRow key={key} label={label} s={stats(per[key], planIdx)} strong />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bandingkan exit</CardTitle>
          <CardDescription>Setup yang sama (filter di atas), beda cara keluar. Klik baris buat pakai exit itu di tab lain.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="num w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b text-right">
                <th className="py-1 text-left">Exit</th>
                <th>Trade</th>
                <th>WR</th>
                <th>Nggak rugi</th>
                <th>Avg R</th>
                <th>Total R</th>
                <th>PF</th>
                <th>OOS trade</th>
                <th>OOS avg R</th>
              </tr>
            </thead>
            <tbody>
              {plans.map(({ x, all, oos }, i) => (
                <tr key={x.key} className={cn('cursor-pointer border-b text-right last:border-0 hover:bg-muted/40', i === planIdx && 'bg-muted/60')} onClick={() => setPlanKey(x.key)}>
                  <td className="py-1.5 text-left font-medium">{x.label}</td>
                  <td>{all.trades}</td>
                  <td>{pct(all.winrate)}</td>
                  <td>{pct(all.noLoss)}</td>
                  <td className={cn('font-semibold', signCls(all.avgR))}>{num(all.avgR)}</td>
                  <td className={signCls(all.totalR)}>{num(all.totalR, 1)}</td>
                  <td>{num(all.profitFactor)}</td>
                  <td>{oos.trades}</td>
                  <td className={signCls(oos.avgR)}>{num(oos.avgR)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <EquityCard r={r} eq={eq} startEquity={startEquity} riskPct={riskPct} />

      <Card>
        <CardHeader>
          <CardTitle>Pecahan</CardTitle>
          <CardDescription>Grup di bawah ~30 trade masih noise. Percaya kalau bagus di dua periode.</CardDescription>
          <div className="flex flex-wrap gap-1 pt-1">
            {GROUPS.map((g) => (
              <Button key={g.key} size="sm" variant={group === g.key ? 'default' : 'outline'} className="h-7" onClick={() => setGroup(g.key)}>
                {g.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="num w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-right">
                <th />
                {PERIODS.map((x) => (
                  <th key={x.key} colSpan={4} className="border-l px-2 text-center">
                    {x.label}
                  </th>
                ))}
              </tr>
              <tr className="border-b text-right">
                <th className="py-1 text-left">{GROUPS.find((g) => g.key === group)!.label}</th>
                {PERIODS.map((x) => (
                  <GroupCols key={x.key} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b text-right last:border-0">
                  <td className="py-1.5 text-left font-medium">{row.key}</td>
                  {PERIODS.map((x) => (
                    <GroupCells key={x.key} s={row[x.key]} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  )
}

function GroupCols() {
  return (
    <>
      <th className="border-l px-2">Trade</th>
      <th className="px-2">WR</th>
      <th className="px-2">Avg R</th>
      <th className="px-2">Total</th>
    </>
  )
}

function GroupCells({ s }: { s: Stats }) {
  return (
    <>
      <td className="border-l px-2">{s.trades}</td>
      <td className="px-2">{pct(s.winrate)}</td>
      <td className={cn('px-2', signCls(s.avgR))}>{num(s.avgR)}</td>
      <td className={cn('px-2', signCls(s.totalR))}>{num(s.totalR, 1)}</td>
    </>
  )
}

function Meta({ r, setups, filter, onSave }: { r: BacktestResult; setups: BtSetup[]; filter: BtFilter; onSave: (p: CoinProfile) => void }) {
  const [minTrades, setMinTrades] = useState(() => recall('backtest.minTrades', 15))
  const [showAll, setShowAll] = useState(false)
  const rows = useMemo(() => metaTable(setups, r.plans.length, r.splitT, minTrades), [setups, r, minTrades])
  const shown = showAll ? rows.slice(0, 200) : rows.filter((x) => x.robust).slice(0, 50)
  const save = (row: (typeof rows)[number]): void =>
    onSave({
      symbol: r.symbol,
      savedAt: Date.now(),
      models: [row.model],
      pois: [row.poi],
      requireConfluence: filter.conf,
      minScore: filter.minScore,
      plan: r.plans[row.plan]!,
      stats: { trades: row.all.trades, winrate: row.all.winrate, avgR: row.all.avgR, oosTrades: row.oos.trades, oosAvgR: row.oos.avgR }
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle>POI "meta" di {r.symbol}</CardTitle>
        <CardDescription>
          Setiap kombinasi model × POI induk × exit, dengan filter konfluensi/skor/arah di atas. <b>Kokoh</b> = avg R positif di in-sample (≥ {minTrades} trade) <b>dan</b> di
          out-of-sample. Yang cuma bagus di satu periode kemungkinan kebetulan. "Pakai" menyimpan kombinasi itu sebagai profil bot untuk {r.symbol}.
        </CardDescription>
        <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
          <label className="flex items-center gap-2">
            Min trade in-sample
            <Input
              type="number"
              className="num h-7 w-16 text-right"
              value={minTrades}
              onChange={(e) => {
                const v = Math.max(1, Number(e.target.value) || 1)
                setMinTrades(v)
                remember('backtest.minTrades', v)
              }}
            />
          </label>
          <Button size="sm" variant="outline" className="h-7" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Cuma yang kokoh' : 'Tampilkan semua kombinasi'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {!shown.length ? (
          <p className="text-sm text-muted-foreground">Belum ada kombinasi yang kokoh dengan filter ini. Coba kurangi konfluensi wajib, turunkan min trade, atau lihat semua kombinasi.</p>
        ) : (
          <table className="num w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-right">
                <th colSpan={3} />
                <th colSpan={3} className="border-l px-2 text-center">
                  In-sample
                </th>
                <th colSpan={3} className="border-l px-2 text-center">
                  Out-of-sample
                </th>
                <th colSpan={2} className="border-l" />
              </tr>
              <tr className="border-b text-right">
                <th className="py-1 text-left">Model</th>
                <th className="text-left">POI induk</th>
                <th className="text-left">Exit</th>
                <GroupColsShort />
                <GroupColsShort />
                <th className="border-l px-2">Total R</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.key} className="border-b text-right last:border-0">
                  <td className="py-1.5 text-left font-medium" title={MODEL_LABEL[row.model]}>
                    {row.model} {row.robust && <Badge variant="bull">kokoh</Badge>}
                  </td>
                  <td className="text-left">{`${POI_LABEL[row.poi.split('|')[0] as PoiKind]} ${row.poi.split('|')[1]}`}</td>
                  <td className="text-left">{r.plans[row.plan]!.label}</td>
                  <ShortCells s={row.is} />
                  <ShortCells s={row.oos} />
                  <td className={cn('border-l px-2 font-semibold', signCls(row.all.totalR))}>{num(row.all.totalR, 1)}</td>
                  <td className="pl-2">
                    <Button size="sm" variant={row.robust ? 'default' : 'outline'} className="h-6 px-2" onClick={() => save(row)}>
                      Pakai
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}

function GroupColsShort() {
  return (
    <>
      <th className="border-l px-2">Trade</th>
      <th className="px-2">WR</th>
      <th className="px-2">Avg R</th>
    </>
  )
}

function ShortCells({ s }: { s: Stats }) {
  return (
    <>
      <td className="border-l px-2">{s.trades}</td>
      <td className="px-2">{pct(s.winrate)}</td>
      <td className={cn('px-2', signCls(s.avgR))}>{num(s.avgR)}</td>
    </>
  )
}

function Trades({ r, setups, planIdx }: { r: BacktestResult; setups: BtSetup[]; planIdx: number }) {
  const rows = useMemo(
    () =>
      setups
        .filter((s) => ['w', 'b', 'l', 'o'].includes(s.res[planIdx]!.s))
        .sort((a, b) => (b.res[planIdx]!.f ?? 0) - (a.res[planIdx]!.f ?? 0))
        .slice(0, 300),
    [setups, planIdx]
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>Trade ({r.plans[planIdx]!.label})</CardTitle>
        <CardDescription>300 terbaru. Klik baris buat buka Chart di waktu itu (entry & SL digambar).</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="num w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b text-right">
              <th className="py-1 text-left">Entry kena</th>
              <th className="text-left">Keluar</th>
              <th className="text-left">Arah</th>
              <th className="text-left">Setup</th>
              <th>Skor</th>
              <th>Entry</th>
              <th>SL</th>
              <th>SL %</th>
              <th className="text-left">Hasil</th>
              <th>R</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const x = s.res[planIdx]!
              return (
                <tr key={s.id} className="cursor-pointer border-b text-right last:border-0 hover:bg-muted/40" onClick={() => openOnChart(r.symbol, s, x.x)} title={s.conf.join(', ')}>
                  <td className="py-1 text-left">{x.f ? formatTime(x.f) : '—'}</td>
                  <td className="text-left">{x.x ? formatTime(x.x) : '—'}</td>
                  <td className="text-left">
                    <Badge variant={s.dir === 'bullish' ? 'bull' : 'bear'}>{s.dir === 'bullish' ? 'LONG' : 'SHORT'}</Badge>
                  </td>
                  <td className="text-left">
                    {s.model} · {POI_LABEL[s.poiKind]} {s.poiTf} → {s.childKind} {s.childTf}
                  </td>
                  <td>{s.score}</td>
                  <td>{px(s.entry)}</td>
                  <td className="text-bear">{px(s.sl)}</td>
                  <td>{s.slPct.toFixed(2)}</td>
                  <td className="text-left">{STATUS_LABEL[x.s] ?? x.s}</td>
                  <td className={cn('font-semibold', signCls(x.r))}>
                    {x.r > 0 ? '+' : ''}
                    {x.r.toFixed(2)}R
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function EquityCard({ r, eq, startEquity, riskPct }: { r: BacktestResult; eq: ReturnType<typeof simulateEquity>; startEquity: number; riskPct: number }) {
  const W = 800
  const H = 160
  const pts = eq.curve
  const path = useMemo(() => {
    if (pts.length < 2) return null
    const t0 = pts[0]!.t
    const t1 = pts.at(-1)!.t || t0 + 1
    const ys = pts.map((p) => p.equity)
    const lo = Math.min(...ys, startEquity)
    const hi = Math.max(...ys, startEquity)
    const x = (t: number): number => ((t - t0) / Math.max(1, t1 - t0)) * W
    const y = (v: number): number => H - 4 - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 8)
    return { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.equity).toFixed(1)}`).join(''), base: y(startEquity), split: x(r.splitT) }
  }, [pts, startEquity, r.splitT])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Simulasi bot: risk {riskPct}% equity per order</CardTitle>
        <CardDescription>
          Size = equity × risk% ÷ jarak SL, maks {r.risk.maxLeverage}× leverage, satu posisi di koin ini, berhenti sisa hari (UTC) kalau rugi ≥ {r.risk.maxDailyLossPct}%.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="num flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            {startEquity.toFixed(2)} → <b className={signCls(eq.endEquity - startEquity)}>{eq.endEquity.toFixed(2)} USDT</b>
          </span>
          <span className={signCls(eq.returnPct)}>
            {eq.returnPct > 0 ? '+' : ''}
            {eq.returnPct.toFixed(1)}%
          </span>
          <span>
            max drawdown <b className="text-bear">{eq.maxDdPct.toFixed(1)}%</b>
          </span>
          <span>{eq.taken} trade diambil</span>
          <span className="text-muted-foreground">
            dilewati: {eq.skippedOpen} (posisi masih buka) · {eq.skippedHalt} (limit rugi harian) · {eq.leverageCapped} dikecilin karena leverage · loss beruntun maks {eq.maxLosingStreak}
          </span>
        </div>
        {path && (
          <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Kurva equity">
            <line x1={0} x2={W} y1={path.base} y2={path.base} className="stroke-muted-foreground/40" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            {path.split > 0 && path.split < W && <line x1={path.split} x2={path.split} y1={0} y2={H} className="stroke-muted-foreground/40" vectorEffect="non-scaling-stroke" />}
            <path d={path.d} fill="none" className={eq.endEquity >= startEquity ? 'stroke-bull' : 'stroke-bear'} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <p className="text-[11px] text-muted-foreground">Garis putus-putus = modal awal · garis tegak = mulai out-of-sample.</p>
      </CardContent>
    </Card>
  )
}

function ReactionCard({ r }: { r: BacktestResult }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reaksi POI (tanpa aturan entry)</CardTitle>
        <CardDescription>
          Tiap POI yang disentuh harga: dari garis POI, mana yang kena duluan, +X% searah POI atau −X% nembus. Di atas ~55% baru kelihatan ada reaksi. Dalam satu candle, sisi rugi
          dihitung duluan. Jendela {r.params.reactionHours} jam.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="num w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b text-right">
              <th className="py-1 text-left">POI</th>
              <th>TF</th>
              <th>Aktif</th>
              <th>Disentuh</th>
              {r.reactions[0]?.race.map((x) => (
                <th key={x.pct}>±{x.pct}%</th>
              ))}
              <th title="Close menembus POI dalam jendela reaksi">Invalid</th>
              <th>Median MFE</th>
              <th>Median MAE</th>
            </tr>
          </thead>
          <tbody>
            {r.reactions.map((x) => (
              <tr key={`${x.kind}-${x.timeframe}`} className="border-b text-right last:border-0">
                <td className="py-1.5 text-left font-medium">{POI_LABEL[x.kind]}</td>
                <td>{x.timeframe}</td>
                <td>{x.pois}</td>
                <td>{x.touches}</td>
                {x.race.map((q) => {
                  const done = q.win + q.loss
                  const rate = done ? q.win / done : null
                  return (
                    <td key={q.pct} className={rate === null ? '' : rate >= 0.55 ? 'text-bull' : rate < 0.45 ? 'text-bear' : ''} title={`${q.win} menang / ${q.loss} kalah / ${q.timeout} belum selesai`}>
                      {pct(rate)} <span className="text-muted-foreground">({done})</span>
                    </td>
                  )
                })}
                <td>{x.touches ? pct(x.invalidated / x.touches) : '—'}</td>
                <td>{x.medianMfePct === null ? '—' : `${x.medianMfePct.toFixed(2)}%`}</td>
                <td>{x.medianMaePct === null ? '—' : `${x.medianMaePct.toFixed(2)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
