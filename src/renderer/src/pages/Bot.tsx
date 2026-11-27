import { useEffect, useState } from 'react'
import { Bot as BotIcon, CandlestickChart, CircleCheck, CircleMinus, CircleX, Loader2, Pause, Play, RefreshCw, RotateCcw, ShieldAlert, Wifi, X } from 'lucide-react'
import { canReopen, EXIT_REASON_LABEL as REASON, tradeOutcome, tradeR, type BotEvent, type BotState, type BotTrade, type ConnTestResult, type ModelStat, type TradeStat } from '@shared/bot'
import type { AppConfig } from '@shared/config'
import { MODEL_LABEL, setupPoiLabel } from '@shared/smc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { botTradeFocus, openChart, tfForModel } from '@/lib/nav'
import { cn, formatTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

const px = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))
const usd = (n: number | null, d = 2): string => (n === null ? '—' : `${n >= 0 ? '' : '−'}${Math.abs(n).toFixed(d)}`)
/** ms → value of a datetime-local input (local time). */
const toLocalInput = (t: number): string => {
  const d = new Date(t)
  return new Date(t - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
const LEVEL: Record<BotEvent['level'], string> = { info: 'text-muted-foreground', skip: 'text-muted-foreground', order: 'text-foreground', warn: 'text-warn', error: 'text-bear' }

export function Bot() {
  const [st, setSt] = useState<BotState | null>(null)
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [liveOpen, setLiveOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [showSkips, setShowSkips] = useState(false)
  const [conn, setConn] = useState<ConnTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [connErr, setConnErr] = useState<string | null>(null)
  const kill = useAppStore((s) => s.status?.killSwitch.active)
  const [refreshing, setRefreshing] = useState(false)
  // the worker answers with a bot:state event; stop the spinner on it (or after 15 s)
  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    const off = window.api.on('bot:state', () => {
      off()
      clearTimeout(timer)
      setRefreshing(false)
    })
    const timer = setTimeout(() => {
      off()
      setRefreshing(false)
    }, 15_000)
    void window.api.invoke('bot:refresh').catch(() => {
      off()
      clearTimeout(timer)
      setRefreshing(false)
    })
  }
  const refreshBtn = (
    <Button size="sm" variant="outline" onClick={refresh} disabled={refreshing} title="Ambil ulang equity Binance, sinkron order & posisi, hitung ulang PnL hari ini">
      <RefreshCw className={refreshing ? 'animate-spin' : ''} /> Refresh
    </Button>
  )

  useEffect(() => {
    void window.api.invoke('bot:get').then(setSt)
    void window.api.invoke('config:get').then(setCfg)
    const offSt = window.api.on('bot:state', setSt)
    const offCfg = window.api.on('config:changed', setCfg)
    return () => {
      offSt()
      offCfg()
    }
  }, [])

  const setEnabled = async (enabled: boolean): Promise<void> => {
    setCfg(await window.api.invoke('config:update', { bot: { enabled } }))
  }
  const setRequireClaude = async (requireClaude: boolean): Promise<void> => {
    setCfg(await window.api.invoke('config:update', { bot: { requireClaude } }))
  }
  const setStatsSince = async (statsSince: number): Promise<void> => {
    setCfg(await window.api.invoke('config:update', { bot: { statsSince } }))
  }
  const setLive = async (live: boolean): Promise<void> => {
    setErr(null)
    try {
      setCfg(await window.api.invoke('bot:setLive', { live, confirm }))
      setLiveOpen(false)
      setConfirm('')
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const testConnection = async (): Promise<void> => {
    setTesting(true)
    setConnErr(null)
    try {
      setConn(await window.api.invoke('bot:testConnection'))
    } catch (e) {
      setConnErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setTesting(false)
    }
  }

  if (!cfg) return null
  const live = cfg.bot.live
  // live: only live trades (old shadow paper trades would mix in and confuse)
  const trades = (st?.trades ?? []).filter((t) => !live || t.mode === 'live')
  const active = trades.filter((t) => t.status === 'pending' || t.status === 'open')
  const done = trades.filter((t) => t.status === 'closed' || t.status === 'cancelled')
  const closed = done.filter((t) => t.status === 'closed' && t.mode === (live ? 'live' : 'paper'))
  const wins = closed.filter((t) => tradeOutcome(t) === 'win').length
  const bes = closed.filter((t) => tradeOutcome(t) === 'be').length
  const losses = closed.length - wins - bes
  const events = (st?.events ?? []).filter((e) => showSkips || e.level !== 'skip')

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <BotIcon className="size-5" />
        <h1 className="text-xl font-semibold tracking-tight">Bot</h1>
        <Badge variant={live ? 'bear' : 'secondary'}>{live ? 'LIVE · uang beneran' : 'PAPER · simulasi'}</Badge>
        <Badge variant={cfg.bot.enabled ? 'bull' : 'outline'}>{cfg.bot.enabled ? 'jalan' : 'mati'}</Badge>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" disabled={testing} onClick={() => void testConnection()}>
            {testing ? <Loader2 className="animate-spin" /> : <Wifi />} Test koneksi
          </Button>
          {live ? (
            <Button size="sm" variant="outline" onClick={() => void setLive(false)}>
              Balik ke paper
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setLiveOpen(true)}>
              <ShieldAlert /> Aktifkan LIVE
            </Button>
          )}
          <Button size="sm" variant={cfg.bot.enabled ? 'secondary' : 'default'} onClick={() => void setEnabled(!cfg.bot.enabled)}>
            {cfg.bot.enabled ? <Pause /> : <Play />}
            {cfg.bot.enabled ? 'Stop bot' : 'Start bot'}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="num grid gap-x-8 gap-y-2 pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              Equity {live ? 'Binance' : 'paper'}
              {st?.equityAt ? <span>· {new Date(st.equityAt).toLocaleTimeString('id-ID', { hour12: false })}</span> : null}
            </div>
            <div className="flex items-center gap-2">
              <div className="text-lg font-semibold">{st?.equity == null ? '—' : `${st.equity.toFixed(2)} USDT`}</div>
              {refreshBtn}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">PnL hari ini (UTC)</div>
            <div className={cn('text-lg font-semibold', (st?.pnlToday ?? 0) > 0 ? 'text-bull' : (st?.pnlToday ?? 0) < 0 ? 'text-bear' : '')}>{usd(st?.pnlToday ?? 0, 3)} USDT</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Trade selesai ({live ? 'live' : 'paper'})</div>
            <div className="text-lg font-semibold">
              {closed.length} · untung {wins} / BE {bes} / rugi {losses}
              {wins + losses > 0 && <span className="ml-1 text-xs font-normal text-muted-foreground">WR {Math.round((wins / (wins + losses)) * 100)}% (tanpa BE)</span>}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Risk per order</div>
            <div className="text-lg font-semibold">
              {cfg.bot.riskPerTradePct}%{cfg.bot.riskBaseUsdt > 0 ? ` × ${cfg.bot.riskBaseUsdt} USDT = ${((cfg.bot.riskBaseUsdt * cfg.bot.riskPerTradePct) / 100).toFixed(2)} USDT` : ' saldo'} · maks {cfg.risk.maxLeverage}× · {cfg.risk.maxOpenPositions} posisi
            </div>
            {Object.keys(cfg.bot.modelRiskPct).length > 0 && (
              <div className="text-xs text-muted-foreground">
                khusus:{' '}
                {Object.entries(cfg.bot.modelRiskPct)
                  .map(([m, p]) => `${m} ${p}%${cfg.bot.riskBaseUsdt > 0 ? ` (${((cfg.bot.riskBaseUsdt * p) / 100).toFixed(2)} USDT)` : ''}`)
                  .join(' · ')}
              </div>
            )}
            {cfg.bot.oteRiskMult > 1 && cfg.bot.oteRiskModels.length > 0 && (
              <div className="text-xs text-muted-foreground">
                golden ratio / OTE ({cfg.bot.oteRiskModels.join('/')}): risk × {cfg.bot.oteRiskMult}
              </div>
            )}
          </div>
          <div className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
            {kill ? (
              <span className="text-bear">Kill Switch aktif: bot nggak akan buka posisi baru.</span>
            ) : st?.blocked ? (
              <>Entry baru diblok: {st.blocked}</>
            ) : (
              <span className="text-bull">Siap entry.</span>
            )}{' '}
            · Universe {st?.universe.count ?? 0} koin crypto top {cfg.bot.topVolume} volume
            {st?.universe.updatedAt ? ` (update ${formatTime(st.universe.updatedAt)})` : ''} · model{' '}
            {cfg.bot.models.map((m) => { const a = cfg.bot.modelConfluence[m]; const o = cfg.bot.modelConfluenceAny?.[m] ?? []; const t = [a.join('+'), o.length ? `salah satu ${o.join('/')}` : ''].filter(Boolean).join(' · '); return `${m}${t ? ` (${t})` : ''}` }).join(', ')}
            {cfg.bot.minScore ? ` · skor ≥ ${cfg.bot.minScore}` : ''} · exit {cfg.exit.tpMode === 'trail' ? 'trailing tanpa TP' : cfg.exit.tpMode === 'fixedR' ? `TP ${cfg.exit.tpR}R` : 'TP liquidity'}
            {cfg.exit.ladder.length ? ` + bertingkat (${cfg.exit.ladder.map((l) => `${l.atR}R→${l.closePct ? `tutup ${l.closePct}% + ` : ''}SL ${l.slToR ? `${l.slToR}R` : 'BE'}`).join(', ')})` : ''}
            {cfg.exit.ladder.some((l) => l.slToR === 0) && cfg.exit.tightSlPct > 0
              ? ` · SL < ${cfg.exit.tightSlPct}%: BE baru di ${cfg.exit.tightBeAtR}R, kunci +${cfg.exit.tightBeLockR}R bersih fee`
              : ''}
            {cfg.exit.orderFlowHold ? ` + tahan order flow (${cfg.exit.orderFlowSignals.join('/')} ${cfg.exit.orderFlowTf}${cfg.exit.orderFlowMoveSl ? ', SL ke retest' : ', SL tetap'})` : ''} ·{' '}
            <button type="button" className="underline decoration-dotted" onClick={() => void setRequireClaude(!cfg.bot.requireClaude)} title="Klik untuk ganti">
              {cfg.bot.requireClaude ? `Claude wajib ≥ ${cfg.bot.minConfidence}` : 'tanpa Claude (murni ICT)'}
            </button>
            {st?.blacklist?.length ? (
              <span className="text-warn" title={`${cfg.bot.slBlacklistCount}× SL dalam ${cfg.bot.slBlacklistHours} jam`}>
                {' '}
                · blacklist SL: {st.blacklist.map((b) => `${b.symbol} (${b.losses}×, s/d ${formatTime(b.until)})`).join(', ')}
              </span>
            ) : (
              ''
            )}
            {st?.awaitingClaude.length ? <span className="text-warn"> · nunggu Claude: {st.awaitingClaude.join(', ')}</span> : ''}
            {st?.lastError && <span className="text-bear"> · error terakhir: {st.lastError}</span>}
          </div>
        </CardContent>
      </Card>

      {(conn || testing || connErr) && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Koneksi Binance Futures</CardTitle>
              <CardDescription>DNS lewat Cloudflare (1.1.1.1 / 1.0.0.1). Read-only, nggak kirim order.</CardDescription>
            </div>
            {conn && <span className="text-xs text-muted-foreground">{formatTime(conn.at)}</span>}
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {testing && !conn && <div className="text-muted-foreground">Ngetes…</div>}
            {connErr && <div className="text-bear">{connErr}</div>}
            {conn?.checks.map((c) => (
              <div key={c.id} className="flex items-start gap-2">
                {c.ok === true ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-bull" />
                ) : c.ok === false ? (
                  <CircleX className="mt-0.5 size-4 shrink-0 text-bear" />
                ) : (
                  <CircleMinus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="w-52 shrink-0 font-medium">{c.label}</span>
                <span className={cn('min-w-0 break-words', c.ok === false ? 'text-bear' : 'text-muted-foreground')}>{c.detail}</span>
                {c.ms !== null && <span className="num ml-auto shrink-0 text-xs text-muted-foreground">{c.ms} ms</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Order & posisi aktif</CardTitle>
            <CardDescription>
              Limit entry dipasang bareng SL (stop-market, close position). TP limit dipasang begitu entry terisi. Limit dibatalin kalau harga sampai TP duluan
              atau setup expired.
            </CardDescription>
          </div>
          {refreshBtn}
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <TradeTable trades={active} actions />
        </CardContent>
      </Card>

      {cfg && st && (
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Per model ({live ? 'live' : 'paper'})</CardTitle>
              <CardDescription>
                Trade yang sudah terisi dan selesai, dibuka sejak tanggal di kanan. WR tanpa BE = untung ÷ (untung + rugi). R = PnL bersih fee ÷ risk awal.
                DD maks = penurunan terbesar total R dari puncaknya.
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs">
              <span className="text-muted-foreground">sejak</span>
              <Input
                type="datetime-local"
                className="h-8 w-48"
                value={cfg.bot.statsSince ? toLocalInput(cfg.bot.statsSince) : ''}
                onChange={(e) => void setStatsSince(e.target.value ? new Date(e.target.value).getTime() : 0)}
              />
              <Button size="sm" variant="ghost" onClick={() => void setStatsSince(0)} disabled={!cfg.bot.statsSince}>
                semua
              </Button>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {!st.statsTotal ? (
              <p className="px-6 pb-4 text-sm text-muted-foreground">Belum ada trade selesai sejak tanggal ini.</p>
            ) : (
              <StatsTable rows={st.modelStats} total={st.statsTotal} />
            )}
            {st.shadowStats && (
              <div className="border-t pt-3">
                <p className="px-6 pb-2 text-xs text-muted-foreground">
                  Shadow paper ({cfg.bot.shadowModels.join(', ')}): jalan di akun paper walaupun bot live, tidak pernah kirim order. Tidak masuk statistik live di
                  atas.
                </p>
                {st.shadowStats.statsTotal ? (
                  <StatsTable rows={st.shadowStats.modelStats} total={st.shadowStats.statsTotal} />
                ) : (
                  <p className="px-6 pb-4 text-sm text-muted-foreground">Belum ada trade shadow yang selesai.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Riwayat</CardTitle>
            <CardDescription>PnL sudah termasuk fee.</CardDescription>
          </div>
          {!live && (
            <Button size="sm" variant="ghost" onClick={() => void window.api.invoke('bot:resetPaper')}>
              <RotateCcw /> Reset akun paper ({cfg.bot.paperEquity} USDT)
            </Button>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <TradeTable trades={done.slice(0, 50)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Log keputusan</CardTitle>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={showSkips} onChange={(e) => setShowSkips(e.target.checked)} />
            tampilkan setup yang dilewati
          </label>
        </CardHeader>
        <CardContent className="max-h-96 space-y-0.5 overflow-y-auto text-xs">
          {events.length === 0 && <div className="text-muted-foreground">Belum ada.</div>}
          {events.map((e) => (
            <div key={e.id} className={cn('flex gap-3', LEVEL[e.level])}>
              <span className="num shrink-0 text-muted-foreground">{formatTime(e.t)}</span>
              {e.symbol && <span className="w-24 shrink-0 font-medium">{e.symbol}</span>}
              <span>{e.message}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={liveOpen} onOpenChange={setLiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aktifkan trading LIVE?</DialogTitle>
            <DialogDescription>
              Bot bakal kirim order beneran ke Binance USDT-M pakai API key lu: isolated margin, One-way Mode, risk {cfg.bot.riskPerTradePct}% equity per order, leverage
              maks {cfg.risk.maxLeverage}×, maks {cfg.risk.maxOpenPositions} posisi, berhenti kalau rugi harian ≥ {cfg.risk.maxDailyLossPct}%. Backtest aturan sekarang
              masih minus setelah fee. Pastikan API key cuma punya izin Futures trade (tanpa withdraw). Ketik <b>LIVE</b> buat lanjut.
            </DialogDescription>
          </DialogHeader>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="LIVE" autoFocus />
          {err && <p className="text-xs text-bear">{err}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Batal</Button>
            </DialogClose>
            <Button variant="destructive" disabled={confirm !== 'LIVE'} onClick={() => void setLive(true)}>
              Aktifkan LIVE
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Two-step market close (first click arms, second click sends) so it can't be hit by accident. */
function CloseMarket({ t }: { t: BotTrade }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const h = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(h)
  }, [armed])
  return (
    <Button
      size="sm"
      variant={armed ? 'destructive' : 'outline'}
      className="h-6 px-2 text-xs whitespace-nowrap"
      title="Tutup posisi pakai market order (reduce-only), lalu SL/TP dibatalkan"
      onClick={() => {
        if (!armed) return setArmed(true)
        setArmed(false)
        void window.api.invoke('bot:close', { id: t.id })
      }}
    >
      {armed ? 'Yakin? klik lagi' : 'Close market'}
    </Button>
  )
}

function StatsTable({ rows, total }: { rows: ModelStat[]; total: TradeStat }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          {['model', 'trade', 'untung', 'BE', 'rugi', 'WR (tanpa BE)', 'BE %', 'total R', 'rata-rata R', 'DD maks', 'PnL'].map((h) => (
            <th key={h} className="px-3 py-1.5 font-normal whitespace-nowrap">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="num">
        {[...rows.map((m) => ({ label: MODEL_LABEL[m.model], m, total: false })), { label: 'Total', m: total, total: true }].map(({ label, m, total: isTotal }) => (
          <tr key={label} className={cn('border-t', isTotal && 'font-medium')}>
            <td className="px-3 py-1.5 whitespace-nowrap">{label}</td>
            <td className="px-3 py-1.5">{m.trades}</td>
            <td className="px-3 py-1.5 text-bull">{m.wins}</td>
            <td className="px-3 py-1.5 text-muted-foreground">{m.bes}</td>
            <td className="px-3 py-1.5 text-bear">{m.losses}</td>
            <td className="px-3 py-1.5">{m.wr === null ? '—' : `${Math.round(m.wr * 100)}%`}</td>
            <td className="px-3 py-1.5 text-muted-foreground">{Math.round((m.bes / m.trades) * 100)}%</td>
            <td className={cn('px-3 py-1.5', m.totalR > 0 ? 'text-bull' : m.totalR < 0 ? 'text-bear' : '')}>{m.totalR.toFixed(2)}R</td>
            <td className={cn('px-3 py-1.5', (m.avgR ?? 0) > 0 ? 'text-bull' : (m.avgR ?? 0) < 0 ? 'text-bear' : '')}>{m.avgR === null ? '—' : `${m.avgR.toFixed(2)}R`}</td>
            <td className={cn('px-3 py-1.5', m.maxDdR > 0 && 'text-bear')}>{m.maxDdR > 0 ? `−${m.maxDdR.toFixed(2)}R` : '0R'}</td>
            <td className={cn('px-3 py-1.5', m.pnl > 0 ? 'text-bull' : m.pnl < 0 ? 'text-bear' : '')}>{m.pnl.toFixed(2)} USDT</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function TradeTable({ trades, actions }: { trades: BotTrade[]; actions?: boolean }) {
  if (!trades.length) return <div className="px-4 py-4 text-sm text-muted-foreground">Belum ada.</div>
  return (
    <table className="num w-full text-xs">
      <thead className="text-muted-foreground">
        <tr className="border-b">
          {['waktu', 'mode', 'simbol', 'arah', 'setup', 'Claude', 'entry / SL / TP', 'qty', 'risk', 'status', 'PnL', ''].map((h) => (
            <th key={h} className="px-3 py-2 text-left font-normal whitespace-nowrap">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id} className="border-t border-border/50">
            <td className="px-3 py-1.5 whitespace-nowrap">{formatTime(t.createdAt)}</td>
            <td className="px-3 py-1.5">
              <Badge variant={t.mode === 'live' ? 'bear' : 'secondary'}>{t.mode}</Badge>
            </td>
            <td className="px-3 py-1.5 font-medium">{t.symbol}</td>
            <td className={cn('px-3 py-1.5', t.direction === 'bullish' ? 'text-bull' : 'text-bear')}>{t.direction === 'bullish' ? 'LONG' : 'SHORT'}</td>
            <td className="px-3 py-1.5 whitespace-nowrap">
              {t.model} · {setupPoiLabel(t.model, t.poi.kind)} {t.poi.timeframe} · skor {t.score}
            </td>
            <td className="px-3 py-1.5">{t.confidence ?? '—'}</td>
            <td className="px-3 py-1.5 whitespace-nowrap">
              {px(t.entry)} / <span className="text-bear">{px(t.sl)}</span>
              {t.sl !== t.slInitial && <span className="text-muted-foreground"> (awal {px(t.slInitial)})</span>} /{' '}
              <span className="text-bull">{t.tp === null ? 'trailing' : px(t.tp)}</span>
            </td>
            <td className="px-3 py-1.5 whitespace-nowrap">
              {t.filledQty ?? t.qty} <span className="text-muted-foreground">({(t.qty * t.entry).toFixed(2)}$ · {t.leverage}×)</span>
            </td>
            <td className="px-3 py-1.5">{t.riskUsd.toFixed(3)}$</td>
            <td className="px-3 py-1.5 whitespace-nowrap">
              {t.status === 'pending' ? (
                <Badge variant="warn">limit nunggu</Badge>
              ) : t.status === 'open' ? (
                <span className="flex items-center gap-1">
                  <Badge variant="warn">posisi buka</Badge>
                  {t.exitState?.holding && <Badge variant="bull">order flow: tahan</Badge>}
                  {t.exitState && <span className="text-muted-foreground">best {t.exitState.bestR}R</span>}
                  {t.closedQty > 0 && <span className="text-muted-foreground">· {t.closedQty} sudah TP</span>}
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  {tradeOutcome(t) === 'be' && <Badge variant="secondary">BE</Badge>}
                  <span className="text-muted-foreground">{REASON[t.reason ?? ''] ?? t.reason}</span>
                </span>
              )}
            </td>
            <td className={cn('px-3 py-1.5 font-semibold whitespace-nowrap', tradeOutcome(t) === 'win' ? 'text-bull' : tradeOutcome(t) === 'loss' ? 'text-bear' : tradeOutcome(t) === 'be' ? 'text-muted-foreground' : '')}>
              {t.pnl === null ? '—' : usd(t.pnl, 3)}
              {t.status === 'closed' && tradeR(t) !== null && <span className="ml-1 font-normal text-muted-foreground">({tradeR(t)!.toFixed(2)}R)</span>}
            </td>
            <td className="px-3 py-1.5">
              {actions && t.status === 'pending' && (
                <Button size="sm" variant="outline" className="h-6 px-2 text-xs" title="Batalkan limit entry" onClick={() => void window.api.invoke('bot:cancel', { id: t.id })}>
                  <X className="size-3" /> Cancel
                </Button>
              )}
              {actions && t.status === 'open' && <CloseMarket t={t} />}
              {(t.status !== 'cancelled' || t.filledAt !== null) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  title={t.status === 'closed' ? 'Lihat trade ini di Chart (entry, SL, TP, exit)' : 'Buka Chart koin ini (garis posisi live)'}
                  onClick={() => openChart(t.symbol, { tf: tfForModel(t.model), ...(t.status === 'closed' ? { focus: botTradeFocus(t) } : {}) })}
                >
                  <CandlestickChart className="size-3" /> Chart
                </Button>
              )}
              {t.status === 'cancelled' && t.reason === 'error' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  title="Cek ulang setup ini dengan data sekarang, lalu pasang lagi kalau masih lolos semua syarat"
                  onClick={() => void window.api.invoke('bot:retry', { id: t.id })}
                >
                  <RotateCcw className="size-3" /> Retry
                </Button>
              )}
              {canReopen(t, Date.now()) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  title="Ketutup manual / kepencet? Pasang lagi limit entry dengan SL & TP yang sama (entry ikut harga sekarang kalau sudah lewat), qty dihitung ulang ke risk yang sama"
                  onClick={() => void window.api.invoke('bot:retry', { id: t.id })}
                >
                  <RotateCcw className="size-3" /> Buka ulang
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
