import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Play, ScanSearch } from 'lucide-react'
import type { ScreenerConfig } from '@shared/config'
import type { ScreenerRow, ScreenerState } from '@shared/screener'
import { poiConcept, setupPoiLabel, type Dir, type PoiConcept } from '@shared/smc'
import { TF_MS } from '@shared/timeframes'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { fmtDuration } from '@/lib/format'
import { cn, formatTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

const px = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))
const TRIGGER: Record<string, string> = { manual: 'manual', auto: 'otomatis (15m close)', startup: 'startup' }

/** Setup status filter: pending = limit belum terisi, triggered = sudah kena entry. */
type EntryFilter = 'all' | 'pending' | 'triggered'

/** POI timeframe filter: HTF = 1h and above, LTF = 15m and below, or one exact TF. */
type TfFilter = 'all' | 'htf' | 'ltf' | '4h' | '1h' | '15m'
const HTF = new Set(['1h', '4h', '1d', '1w'])
/** TF of the POI behind the row: the setup's POI, else the nearest active POI. */
const poiTf = (r: ScreenerRow): string | null => r.setup?.poi.timeframe ?? r.nearPoi?.timeframe ?? null
const tfMatch = (r: ScreenerRow, f: TfFilter): boolean => {
  if (f === 'all') return true
  const tf = poiTf(r)
  if (!tf) return false
  return f === 'htf' ? HTF.has(tf) : f === 'ltf' ? !HTF.has(tf) : tf === f
}

/** SMC concept (POI kind) of the row: the setup's POI, else the nearest active POI. */
const KINDS: { key: PoiConcept; label: string }[] = [
  { key: 'OB', label: 'OB' },
  { key: 'BREAKER', label: 'Breaker' },
  { key: 'RBS', label: 'RBS' },
  { key: 'SBR', label: 'SBR' },
  { key: 'QM', label: 'QM' },
  { key: 'OCL', label: 'OCL' },
  { key: 'OCL_BREAK', label: 'OCL break' }
]
const poiKind = (r: ScreenerRow): PoiConcept | null => (r.setup ? poiConcept(r.setup.model, r.setup.poi.kind) : r.nearPoi?.kind ?? null)

type Criterion = 'setup' | 'nearPoi' | 'trend' | 'bos'
const CRITERIA: { key: Criterion; label: string; test: (r: ScreenerRow) => boolean }[] = [
  { key: 'setup', label: 'Setup OB valid aktif', test: (r) => !!r.setup },
  { key: 'nearPoi', label: 'Dekat POI', test: (r) => !!r.nearPoi },
  { key: 'trend', label: 'Trend searah 4h/1h/15m', test: (r) => r.trendAligned },
  { key: 'bos', label: 'BOS baru', test: (r) => !!r.recentBos }
]

/** Signed distance from price to the setup entry, % of price. */
const entryDist = (r: ScreenerRow): number => ((r.setup!.entry - r.price) / r.price) * 100
/** Price already reached the TP without filling the entry (detector keeps such setups pending until expiry). */
const pastTp = (r: ScreenerRow): boolean => !!r.setup && (r.direction === 'bullish' ? r.price >= r.setup.tp : r.price <= r.setup.tp)

type SortKey = string | number | null
/** Table columns; `sort` gives the value a click on the header sorts by (null = always last). */
const COLUMNS: { label: string; title?: string; sort: (r: ScreenerRow) => SortKey }[] = [
  { label: 'simbol', sort: (r) => r.symbol },
  { label: 'arah', sort: (r) => r.direction },
  { label: 'harga', sort: (r) => r.price },
  { label: 'setup OB valid', title: 'urut skor setup', sort: (r) => r.setup?.score ?? null },
  { label: 'entry / SL / TP', title: 'urut jarak entry–SL (% dari entry)', sort: (r) => (r.setup ? (Math.abs(r.setup.entry - r.setup.sl) / r.setup.entry) * 100 : null) },
  { label: 'ke entry', title: 'urut jarak harga ke entry (absolut)', sort: (r) => (r.setup ? Math.abs(entryDist(r)) : null) },
  { label: 'RR', sort: (r) => r.setup?.rr ?? null },
  { label: 'POI terdekat', title: 'urut jarak ke POI', sort: (r) => r.nearPoi?.distPct ?? null },
  { label: 'trend', title: 'urut jumlah TF yang searah', sort: (r) => (['4h', '1h', '15m'] as const).filter((tf) => r.trend[tf] === r.direction).length },
  { label: 'BOS', title: 'urut waktu BOS', sort: (r) => r.recentBos?.t ?? null },
  { label: 'data', title: 'urut umur data', sort: (r) => r.dataT }
]

function sortRows(rows: ScreenerRow[], col: number, desc: boolean): ScreenerRow[] {
  const key = COLUMNS[col]!.sort
  return [...rows].sort((a, b) => {
    const x = key(a)
    const y = key(b)
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1 // empty cells last
    const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number)
    return desc ? -c : c
  })
}

const ago = (t: number, now: number): string => {
  const m = Math.max(0, Math.round((now - t) / 60_000))
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}j` : `${Math.round(m / 1440)}h`
}

function TrendDots({ trend }: { trend: ScreenerRow['trend'] }) {
  return (
    <span className="inline-flex gap-1">
      {(['4h', '1h', '15m'] as const).map((tf) => (
        <span
          key={tf}
          title={`${tf}: ${trend[tf] ?? 'belum ada'}`}
          className={cn(
            'rounded px-1 text-[10px]',
            trend[tf] === 'bullish' ? 'bg-bull/15 text-bull' : trend[tf] === 'bearish' ? 'bg-bear/15 text-bear' : 'bg-muted text-muted-foreground'
          )}
        >
          {tf}
        </span>
      ))}
    </span>
  )
}

function openChart(symbol: string): void {
  try {
    localStorage.setItem('chart.symbol', symbol)
    localStorage.setItem('chart.tf', '15m')
  } catch {
    /* storage unavailable */
  }
  useAppStore.getState().setPage('chart')
}

function SettingsRow() {
  const [c, setC] = useState<ScreenerConfig | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    void window.api.invoke('config:get').then((cfg) => setC(cfg.screener))
  }, [])
  if (!c) return null
  const save = async (patch: Partial<ScreenerConfig>): Promise<void> => {
    const next = await window.api.invoke('config:update', { screener: patch })
    setC(next.screener)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <label className="flex items-center gap-2">
        Dekat POI ≤
        <Input
          type="number"
          step={0.1}
          min={0.05}
          max={10}
          className="num h-7 w-20 text-right"
          defaultValue={c.nearPoiPct}
          onBlur={(e) => Number(e.target.value) !== c.nearPoiPct && void save({ nearPoiPct: Number(e.target.value) })}
        />
        %
      </label>
      <label className="flex items-center gap-2">
        BOS ≤
        <Input
          type="number"
          step={1}
          min={1}
          max={168}
          className="num h-7 w-20 text-right"
          defaultValue={c.bosRecentHours}
          onBlur={(e) => Number(e.target.value) !== c.bosRecentHours && void save({ bosRecentHours: Math.round(Number(e.target.value)) })}
        />
        jam
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={c.autoScan} onChange={(e) => void save({ autoScan: e.target.checked })} />
        Scan otomatis tiap 15m close
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={c.notify} onChange={(e) => void save({ notify: e.target.checked })} />
        Notifikasi setup baru
      </label>
      <span>
        POI {c.poiTimeframes.join('/')} · BOS {c.bosTimeframes.join('/')} · data basi &gt; {c.maxDataAgeMin}m dilewati
      </span>
      {saved && <span className="text-bull">tersimpan · berlaku di scan berikutnya</span>}
    </div>
  )
}

export function Screener() {
  const [st, setSt] = useState<ScreenerState | null>(null)
  const [dir, setDir] = useState<Dir | 'all'>('all')
  const [must, setMust] = useState<Set<Criterion>>(new Set())
  const [query, setQuery] = useState('')
  // 0 = any score; otherwise rows need a setup with score ≥ minScore (Setup.score range 1–8)
  const [minScore, setMinScore] = useState(0)
  const [entry, setEntry] = useState<EntryFilter>('all')
  const [tfF, setTfF] = useState<TfFilter>('all')
  // empty = every concept
  const [kinds, setKinds] = useState<Set<PoiConcept>>(new Set())
  const [now, setNow] = useState(Date.now())
  // null = screener ranking (setup first, more criteria, closer POI)
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null)

  useEffect(() => {
    void window.api.invoke('screener:get').then(setSt)
    const off = window.api.on('screener:state', setSt)
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [])

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase()
    const list = (st?.rows ?? []).filter(
      (r) =>
        (dir === 'all' || r.direction === dir) &&
        (!q || r.symbol.includes(q)) &&
        CRITERIA.every((c) => !must.has(c.key) || c.test(r)) &&
        (minScore === 0 || (r.setup?.score ?? 0) >= minScore) &&
        (entry === 'all' || r.setup?.status === entry) &&
        tfMatch(r, tfF) &&
        (kinds.size === 0 || kinds.has(poiKind(r)!))
    )
    return sort ? sortRows(list, sort.col, sort.desc) : list
  }, [st, dir, must, query, sort, minScore, entry, tfF, kinds])

  // click: ascending → descending → back to the screener ranking
  const clickHeader = (col: number): void =>
    setSort((s) => (s?.col !== col ? { col, desc: false } : !s.desc ? { col, desc: true } : null))

  const counts = useMemo(() => Object.fromEntries(CRITERIA.map((c) => [c.key, (st?.rows ?? []).filter(c.test).length])), [st])
  const kindCounts = useMemo(() => {
    const m: Partial<Record<PoiConcept, number>> = {}
    for (const r of st?.rows ?? []) {
      const k = poiKind(r)
      if (k) m[k] = (m[k] ?? 0) + 1
    }
    return m
  }, [st])
  const statusCounts = useMemo(() => {
    const rs = st?.rows ?? []
    return { pending: rs.filter((r) => r.setup?.status === 'pending').length, triggered: rs.filter((r) => r.setup?.status === 'triggered').length }
  }, [st])
  const run = st?.lastRun

  return (
    <div className="w-full space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Screener</h1>
        <span className="text-xs text-muted-foreground">bahan entry dari data tersimpan · kandidat, bukan order</span>
        <Button size="sm" className="ml-auto" disabled={st?.running} onClick={() => window.api.invoke('screener:run')}>
          {st?.running ? <ScanSearch className="animate-pulse" /> : <Play />}
          {st?.running ? 'Scanning…' : 'Scan sekarang'}
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-3 pt-4">
          {st?.running && st.progress ? (
            <div className="flex items-center gap-3 text-xs">
              <Progress value={(st.progress.done / Math.max(1, st.progress.total)) * 100} className="h-1.5 flex-1" />
              <span className="num text-muted-foreground">
                {st.progress.done}/{st.progress.total} koin
              </span>
            </div>
          ) : (
            <div className="num text-xs text-muted-foreground">
              {run ? (
                <>
                  Scan terakhir {formatTime(run.finishedAt)} ({TRIGGER[run.trigger]}) · {run.scanned} koin dalam{' '}
                  {fmtDuration(run.finishedAt - run.startedAt)} · {st?.rows.length ?? 0} kandidat
                  {run.stale > 0 && <> · {run.stale} data basi dilewati</>}
                  {run.errors > 0 && <span className="text-bear"> · {run.errors} error (lihat log)</span>}
                </>
              ) : (
                'Belum pernah scan. Tekan “Scan sekarang”, atau tunggu scan otomatis.'
              )}
              {st?.lastError && <span className="text-bear"> · {st.lastError}</span>}
            </div>
          )}
          <SettingsRow />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'bullish', 'bearish'] as const).map((d) => (
          <Button key={d} size="sm" variant={dir === d ? 'secondary' : 'ghost'} onClick={() => setDir(d)}>
            {d === 'all' ? 'Semua' : d === 'bullish' ? 'Long' : 'Short'}
          </Button>
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        <span className="text-xs text-muted-foreground">wajib:</span>
        {CRITERIA.map((c) => {
          const on = must.has(c.key)
          return (
            <Button
              key={c.key}
              size="sm"
              variant={on ? 'secondary' : 'outline'}
              onClick={() => {
                const next = new Set(must)
                if (on) next.delete(c.key)
                else next.add(c.key)
                setMust(next)
              }}
            >
              {c.label} <span className="num text-muted-foreground">{counts[c.key] ?? 0}</span>
            </Button>
          )
        })}
        <span className="mx-1 h-5 w-px bg-border" />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          skor
          <select className="num h-8 rounded-md border bg-background px-2 text-xs text-foreground" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}>
            <option value={0}>semua</option>
            {[2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                ≥ {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          status
          <select className="h-8 rounded-md border bg-background px-2 text-xs text-foreground" value={entry} onChange={(e) => setEntry(e.target.value as EntryFilter)}>
            <option value="all">semua</option>
            <option value="pending">belum entry ({statusCounts.pending})</option>
            <option value="triggered">sudah entry ({statusCounts.triggered})</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground" title="TF POI setup (atau POI terdekat kalau belum ada setup)">
          TF POI
          <select className="num h-8 rounded-md border bg-background px-2 text-xs text-foreground" value={tfF} onChange={(e) => setTfF(e.target.value as TfFilter)}>
            <option value="all">semua</option>
            <option value="htf">HTF (1h/4h)</option>
            <option value="ltf">LTF (15m)</option>
            <option value="4h">4h</option>
            <option value="1h">1h</option>
            <option value="15m">15m</option>
          </select>
        </label>
        <Input className="num ml-auto h-8 w-40" placeholder="cari simbol" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="flex flex-wrap items-center gap-2" title="Konsep POI dari setup (atau POI terdekat kalau belum ada setup). Kosong = semua.">
        <span className="text-xs text-muted-foreground">konsep:</span>
        {KINDS.map((k) => {
          const on = kinds.has(k.key)
          return (
            <Button
              key={k.key}
              size="sm"
              variant={on ? 'secondary' : 'outline'}
              onClick={() => {
                const next = new Set(kinds)
                if (on) next.delete(k.key)
                else next.add(k.key)
                setKinds(next)
              }}
            >
              {k.label} <span className="num text-muted-foreground">{kindCounts[k.key] ?? 0}</span>
            </Button>
          )
        })}
        {kinds.size > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setKinds(new Set())}>
            reset
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          {rows.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              {st?.rows.length ? 'Nggak ada kandidat yang cocok dengan filter.' : 'Belum ada kandidat.'}
            </div>
          ) : (
            <table className="num w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  {COLUMNS.map((c, i) => {
                    const active = sort?.col === i
                    const Icon = !active ? ArrowUpDown : sort.desc ? ArrowDown : ArrowUp
                    return (
                      <th key={c.label} className="px-3 py-2 text-left font-normal whitespace-nowrap" aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                        <button
                          type="button"
                          title={`${c.title ?? `urut ${c.label}`} · klik lagi untuk balik arah, klik ketiga kembali ke ranking screener`}
                          className={cn('inline-flex items-center gap-1 hover:text-foreground', active && 'text-foreground')}
                          onClick={() => clickHeader(i)}
                        >
                          {c.label}
                          <Icon className={cn('size-3', !active && 'opacity-40')} />
                        </button>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const s = r.setup
                  const stale = now - r.dataT > 20 * 60_000
                  return (
                    <tr
                      key={`${r.symbol}-${r.direction}`}
                      className="cursor-pointer border-t border-border/50 hover:bg-accent/50"
                      title="Buka di Chart (15m)"
                      onClick={() => openChart(r.symbol)}
                    >
                      <td className="px-3 py-1.5 font-medium">{r.symbol}</td>
                      <td className={cn('px-3 py-1.5', r.direction === 'bullish' ? 'text-bull' : 'text-bear')}>
                        {r.direction === 'bullish' ? 'LONG' : 'SHORT'}
                      </td>
                      <td className="px-3 py-1.5">{px(r.price)}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {s ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Badge variant="warn">{s.status === 'triggered' ? 'kena entry' : 'pending'}</Badge>
                            <span className="text-muted-foreground">
                              {setupPoiLabel(s.model, s.poi.kind)} {s.poi.timeframe} · skor {s.score} · {ago(s.createdT, now)} lalu
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {s ? (
                          <>
                            {px(s.entry)} / <span className="text-bear">{px(s.sl)}</span> / <span className="text-bull">{px(s.tp)}</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {s ? (
                          pastTp(r) ? (
                            <Badge variant="outline" title="Harga sudah sampai TP tanpa mengisi entry">
                              lewat TP
                            </Badge>
                          ) : (
                            <span className={cn(Math.abs(entryDist(r)) > 3 && 'text-muted-foreground')}>
                              {entryDist(r) > 0 ? '+' : ''}
                              {entryDist(r).toFixed(2)}%
                            </span>
                          )
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-1.5">{s ? s.rr : '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {r.nearPoi ? (
                          <>
                            {r.nearPoi.kind} {r.nearPoi.timeframe} @{px(r.nearPoi.level)}{' '}
                            <span className="text-muted-foreground">({r.nearPoi.distPct.toFixed(2)}%)</span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <TrendDots trend={r.trend} />
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {r.recentBos ? (
                          <>
                            {r.recentBos.timeframe} @{px(r.recentBos.level)}{' '}
                            <span className="text-muted-foreground">{ago(r.recentBos.t + TF_MS[r.recentBos.timeframe], now)} lalu</span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className={cn('px-3 py-1.5', stale ? 'text-warn' : 'text-muted-foreground')} title={formatTime(r.dataT)}>
                        {ago(r.dataT, now)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
