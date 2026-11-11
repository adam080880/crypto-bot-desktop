import { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react'
import type { AppConfig, DataConfig, RiskConfig } from '@shared/config'
import type { SecretName, SecretStatus } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatTime } from '@/lib/utils'

const SECRET_LABELS: Record<SecretName, string> = {
  'binance.apiKey': 'Binance API Key',
  'binance.apiSecret': 'Binance API Secret',
  'anthropic.apiKey': 'Anthropic API Key'
}

function SecretRow({ s, onChange }: { s: SecretStatus; onChange: (list: SecretStatus[]) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="grid grid-cols-[180px_1fr_auto_auto] items-center gap-3">
      <Label htmlFor={s.name}>{SECRET_LABELS[s.name]}</Label>
      <Input
        id={s.name}
        type="password"
        autoComplete="off"
        placeholder={s.stored ? '•••••••• (tersimpan, isi untuk mengganti)' : 'Belum diisi'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        size="sm"
        disabled={!value.trim()}
        onClick={async () => {
          try {
            onChange(await window.api.invoke('secrets:set', { name: s.name, value }))
            setValue('')
            setError(null)
          } catch (e) {
            setError((e as Error).message)
          }
        }}
      >
        Simpan
      </Button>
      <Button
        size="icon"
        variant="ghost"
        disabled={!s.stored}
        aria-label="Hapus"
        onClick={async () => onChange(await window.api.invoke('secrets:delete', { name: s.name }))}
      >
        <Trash2 />
      </Button>
      <div />
      <div className="col-span-3 -mt-2 text-xs text-muted-foreground">
        {error ? (
          <span className="text-bear">{error}</span>
        ) : s.stored ? (
          <>Diperbarui <span className="num">{formatTime(s.updatedAt)}</span></>
        ) : null}
      </div>
    </div>
  )
}

const RISK_FIELDS: { key: Exclude<keyof RiskConfig, 'requireStopLoss'>; label: string; step: number }[] = [
  { key: 'maxPositionPct', label: 'Max size per posisi (% equity)', step: 0.1 },
  { key: 'maxDailyLossPct', label: 'Max daily loss (% equity) → bot berhenti', step: 0.1 },
  { key: 'maxOpenPositions', label: 'Max posisi terbuka', step: 1 },
  { key: 'maxLeverage', label: 'Max leverage', step: 1 }
]

export function Settings() {
  const [secrets, setSecrets] = useState<SecretStatus[]>([])
  const [encOk, setEncOk] = useState<boolean | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [risk, setRisk] = useState<RiskConfig | null>(null)
  const [riskMsg, setRiskMsg] = useState<string | null>(null)

  useEffect(() => {
    void window.api.invoke('secrets:list').then(setSecrets)
    void window.api.invoke('secrets:encryptionAvailable').then(setEncOk)
    void window.api.invoke('config:get').then((c) => {
      setConfig(c)
      setRisk(c.risk)
    })
  }, [])

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> API Keys
            {encOk === false ? (
              <Badge variant="bear">safeStorage tidak tersedia</Badge>
            ) : (
              <Badge variant="bull">
                <ShieldCheck /> Terenkripsi (safeStorage)
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Disimpan terenkripsi oleh OS keychain. Nilai tidak pernah ditampilkan atau dikirim balik ke UI.
            Pakai key testnet / read-only dulu.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {secrets.map((s) => (
            <SecretRow key={s.name} s={s} onChange={setSecrets} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Risk Guard</CardTitle>
          <CardDescription>
            Ditegakkan di kode, bukan di prompt. Stop-loss wajib di setiap order (tidak bisa dimatikan).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {risk &&
            RISK_FIELDS.map((f) => (
              <div key={f.key} className="grid grid-cols-[1fr_140px] items-center gap-3">
                <Label htmlFor={f.key}>{f.label}</Label>
                <Input
                  id={f.key}
                  type="number"
                  step={f.step}
                  className="num text-right"
                  value={risk[f.key]}
                  onChange={(e) => setRisk({ ...risk, [f.key]: Number(e.target.value) })}
                />
              </div>
            ))}
          <div className="flex items-center gap-3 pt-2">
            <Button
              size="sm"
              onClick={async () => {
                if (!risk) return
                const { requireStopLoss: _sl, ...patch } = risk
                try {
                  const next = await window.api.invoke('config:update', { risk: patch })
                  setConfig(next)
                  setRisk(next.risk)
                  setRiskMsg('Tersimpan')
                } catch (e) {
                  setRiskMsg(`Gagal: nilai tidak valid`)
                  console.error(e)
                }
              }}
            >
              Simpan risk
            </Button>
            {riskMsg && <span className="text-xs text-muted-foreground">{riskMsg}</span>}
          </div>
        </CardContent>
      </Card>

      {config && <DataSettings config={config} onSaved={setConfig} />}

      <Card>
        <CardHeader>
          <CardTitle>Mode & Exchange</CardTitle>
          <CardDescription>Order live belum diimplementasikan. Mode tersedia: paper, testnet.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          <div>
            Mode: <span className="num text-foreground">{config?.mode}</span>
          </div>
          <div>
            Exchange: <span className="num text-foreground">{config?.exchangeId}</span>
          </div>
          <div>
            Watchlist: <span className="num text-foreground">{config?.watchlist.join(', ')}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function DataSettings({ config, onSaved }: { config: AppConfig; onSaved: (c: AppConfig) => void }) {
  const [watchlist, setWatchlist] = useState(config.watchlist.join(', '))
  const [exclude, setExclude] = useState(config.data.excludeSymbols.join(', '))
  const [d, setD] = useState<DataConfig>(config.data)
  const [msg, setMsg] = useState<string | null>(null)
  const list = (v: string): string[] =>
    v
      .split(/[\s,]+/)
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data & Sync</CardTitle>
        <CardDescription>Watchlist selalu di-stream live (WebSocket). Simbol lain di-update lewat REST berkala.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-[1fr_2fr] items-center gap-3">
          <Label htmlFor="watchlist">Watchlist</Label>
          <Input id="watchlist" className="num" value={watchlist} onChange={(e) => setWatchlist(e.target.value)} />
          <Label htmlFor="exclude">Simbol dikecualikan</Label>
          <Input id="exclude" className="num" value={exclude} onChange={(e) => setExclude(e.target.value)} />
          <Label htmlFor="poll">Interval REST (menit)</Label>
          <Input
            id="poll"
            type="number"
            min={1}
            max={60}
            className="num w-28 text-right"
            value={d.restPollMinutes}
            onChange={(e) => setD({ ...d, restPollMinutes: Number(e.target.value) })}
          />
        </div>
        {(
          [
            ['autoSync', 'Auto-sync saat app dibuka & berkala'],
            ['excludeNonAscii', 'Kecualikan simbol bernama non-ASCII'],
            ['keepAwake', 'Cegah komputer sleep selama live data jalan (dan bot tidak di-halt)']
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d[key]} onChange={(e) => setD({ ...d, [key]: e.target.checked })} />
            {label}
          </label>
        ))}
        <div className="flex items-center gap-3 pt-1">
          <Button
            size="sm"
            onClick={async () => {
              try {
                const next = await window.api.invoke('config:update', {
                  watchlist: list(watchlist),
                  data: {
                    excludeSymbols: list(exclude),
                    restPollMinutes: d.restPollMinutes,
                    autoSync: d.autoSync,
                    excludeNonAscii: d.excludeNonAscii,
                    keepAwake: d.keepAwake
                  }
                })
                onSaved(next)
                setMsg('Tersimpan')
              } catch {
                setMsg('Gagal: cek format simbol (contoh BTCUSDT) dan angka interval')
              }
            }}
          >
            Simpan data & sync
          </Button>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
