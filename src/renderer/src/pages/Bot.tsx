import { useEffect, useState } from 'react'
import { Bot as BotIcon, CircleCheck, CircleMinus, CircleX, Loader2, Pause, Play, RotateCcw, ShieldAlert, Wifi, X } from 'lucide-react'
import type { BotEvent, BotState, BotTrade, ConnTestResult } from '@shared/bot'
import type { AppConfig } from '@shared/config'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn, formatTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

const px = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))
const usd = (n: number | null, d = 2): string => (n === null ? '—' : `${n >= 0 ? '' : '−'}${Math.abs(n).toFixed(d)}`)
const REASON: Record<string, string> = {
  tp: 'TP',
  sl: 'SL',
  missed: 'lewat TP',
  expired: 'expired',
  kill: 'kill switch',
  manual: 'dibatalkan',
  error: 'error',
  external: 'di luar bot'
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

  useEffect(() => {
    void window.api.invoke('bot:get').then(setSt)
    void window.api.invoke('config:get').then(setCfg)
    return window.api.on('bot:state', setSt)
  }, [])

  const setEnabled = async (enabled: boolean): Promise<void> => {
    setCfg(await window.api.invoke('config:update', { bot: { enabled } }))
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
  const active = (st?.trades ?? []).filter((t) => t.status === 'pending' || t.status === 'open')
  const done = (st?.trades ?? []).filter((t) => t.status === 'closed' || t.status === 'cancelled')
  const closed = done.filter((t) => t.status === 'closed' && t.mode === (live ? 'live' : 'paper'))
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length
  const events = (st?.events ?? []).filter((e) => showSkips || e.level !== 'skip')

  return (
    <div className="max-w-7xl space-y-4">
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
            <div className="text-xs text-muted-foreground">Equity {live ? 'Binance' : 'paper'}</div>
            <div className="text-lg font-semibold">{st?.equity == null ? '—' : `${st.equity.toFixed(2)} USDT`}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">PnL hari ini (UTC)</div>
            <div className={cn('text-lg font-semibold', (st?.pnlToday ?? 0) > 0 ? 'text-bull' : (st?.pnlToday ?? 0) < 0 ? 'text-bear' : '')}>{usd(st?.pnlToday ?? 0, 3)} USDT</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Trade selesai ({live ? 'live' : 'paper'})</div>
            <div className="text-lg font-semibold">
              {closed.length} · TP {wins} / SL {closed.length - wins}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Risk per order</div>
            <div className="text-lg font-semibold">
              {cfg.bot.riskPerTradePct}% · maks {cfg.risk.maxLeverage}× · {cfg.risk.maxOpenPositions} posisi
            </div>
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
            {st?.universe.updatedAt ? ` (update ${formatTime(st.universe.updatedAt)})` : ''} · setup POI {cfg.bot.poiTimeframes.join('/')} → OB valid {cfg.smc.entryTimeframe} · Claude
            wajib ≥ {cfg.bot.minConfidence}
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
        <CardHeader>
          <CardTitle>Order & posisi aktif</CardTitle>
          <CardDescription>
            Limit entry dipasang bareng SL (stop-market, close position). TP limit dipasang begitu entry terisi. Limit dibatalin kalau harga sampai TP duluan
            atau setup expired.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <TradeTable trades={active} actions />
        </CardContent>
      </Card>

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

function TradeTable({ trades, actions }: { trades: BotTrade[]; actions?: boolean }) {
  if (!trades.length) return <div className="px-4 py-4 text-sm text-muted-foreground">Belum ada.</div>
  return (
    <table className="num w-full text-xs">
      <thead className="text-muted-foreground">
        <tr className="border-b">
          {['waktu', 'mode', 'simbol', 'arah', 'POI', 'Claude', 'entry / SL / TP', 'qty', 'risk', 'status', 'PnL', ''].map((h) => (
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
              {t.poi.kind} {t.poi.timeframe} · skor {t.score}
            </td>
            <td className="px-3 py-1.5">{t.confidence}</td>
            <td className="px-3 py-1.5 whitespace-nowrap">
              {px(t.entry)} / <span className="text-bear">{px(t.sl)}</span> / <span className="text-bull">{px(t.tp)}</span>
            </td>
            <td className="px-3 py-1.5 whitespace-nowrap">
              {t.filledQty ?? t.qty} <span className="text-muted-foreground">({(t.qty * t.entry).toFixed(2)}$ · {t.leverage}×)</span>
            </td>
            <td className="px-3 py-1.5">{t.riskUsd.toFixed(3)}$</td>
            <td className="px-3 py-1.5 whitespace-nowrap">
              {t.status === 'pending' ? (
                <Badge variant="warn">limit nunggu</Badge>
              ) : t.status === 'open' ? (
                <Badge variant="warn">posisi buka</Badge>
              ) : (
                <span className="text-muted-foreground">{REASON[t.reason ?? ''] ?? t.reason}</span>
              )}
            </td>
            <td className={cn('px-3 py-1.5 font-semibold', (t.pnl ?? 0) > 0 ? 'text-bull' : (t.pnl ?? 0) < 0 ? 'text-bear' : '')}>{t.pnl === null ? '—' : usd(t.pnl, 3)}</td>
            <td className="px-3 py-1.5">
              {actions && t.status === 'pending' && (
                <Button size="sm" variant="ghost" className="h-6 px-2" title="Batalkan limit entry" onClick={() => void window.api.invoke('bot:cancel', { id: t.id })}>
                  <X className="size-3" />
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
