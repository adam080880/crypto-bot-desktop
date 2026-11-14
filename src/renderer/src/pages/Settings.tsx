import { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react'
import type { AppConfig, DataConfig, RiskConfig } from '@shared/config'
import type { SecretName, SecretStatus } from '@shared/ipc'
import { CONFLUENCE_CHOICES, ENTRY_MODELS, MODEL_LABEL } from '@shared/smc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatTime } from '@/lib/utils'
import { StorageSettings } from '@/components/StorageSettings'

/** Readable reason from a zod error that crossed IPC ("bot.maxSetupAgeMin: Too big ..."). */
function failMsg(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  const m = text.match(/\[[\s\S]*\]/)
  if (m) {
    try {
      const issues = JSON.parse(m[0]) as { path?: (string | number)[]; message?: string }[]
      return 'Gagal: ' + issues.map((i) => `${(i.path ?? []).join('.')}: ${i.message ?? ''}`).join('; ')
    } catch {
      /* not zod JSON */
    }
  }
  return `Gagal: ${text}`
}

const SECRET_LABELS: Record<SecretName, string> = {
  'binance.apiKey': 'Binance API Key',
  'binance.apiSecret': 'Binance API Secret',
  'anthropic.apiKey': 'Anthropic API Key',
  'bls.apiKey': 'BLS API Key (opsional)'
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
    return window.api.on('config:changed', setConfig)
  }, [])

  return (
    <div className="w-full space-y-4">
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
                  setRiskMsg(failMsg(e))
                }
              }}
            >
              Simpan risk
            </Button>
            {riskMsg && <span className="text-xs text-muted-foreground">{riskMsg}</span>}
          </div>
        </CardContent>
      </Card>

      <StorageSettings />
      {config && <DataSettings config={config} onSaved={setConfig} />}
      {config && <NewsSettings config={config} onSaved={setConfig} />}
      {config && <ClaudeSettings config={config} onSaved={setConfig} />}
      {config && <BotSettings config={config} onSaved={setConfig} />}

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
              } catch (e) {
                setMsg(failMsg(e))
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

function NewsSettings({ config, onSaved }: { config: AppConfig; onSaved: (c: AppConfig) => void }) {
  const n = config.news
  const [mode, setMode] = useState(n.cryptoBiasMode)
  const [before, setBefore] = useState(n.windowBeforeMin)
  const [after, setAfter] = useState(n.windowAfterMin)
  const [strategy, setStrategy] = useState(n.newsStrategyEnabled)
  const [rules, setRules] = useState(JSON.stringify(n.rules, null, 2))
  const [msg, setMsg] = useState<string | null>(null)

  return (
    <Card>
      <CardHeader>
        <CardTitle>News & interpretasi</CardTitle>
        <CardDescription>
          Aturan bias USD per event (regex judul, arah, sumber actual resmi). Konten feed diperlakukan sebagai data, bukan
          instruksi.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-[1fr_2fr] items-center gap-3">
          <Label>Bias crypto</Label>
          <select
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="inverse">inverse — USD bearish → crypto bullish</option>
            <option value="same">same — ikut arah USD</option>
            <option value="off">off — tanpa bias crypto</option>
          </select>
          <Label htmlFor="nwb">News window sebelum / sesudah (menit)</Label>
          <div className="flex gap-2">
            <Input id="nwb" type="number" className="num w-24 text-right" value={before} onChange={(e) => setBefore(Number(e.target.value))} />
            <Input type="number" className="num w-24 text-right" value={after} onChange={(e) => setAfter(Number(e.target.value))} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={strategy} onChange={(e) => setStrategy(e.target.checked)} />
          Strategi news aktif (boleh buka posisi selama news window)
        </label>
        <Label htmlFor="rules">Aturan interpretasi (JSON)</Label>
        <textarea
          id="rules"
          spellCheck={false}
          className="num selectable h-64 w-full rounded-md border border-input bg-transparent p-2 text-xs"
          value={rules}
          onChange={(e) => setRules(e.target.value)}
        />
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={async () => {
              let parsed: unknown
              try {
                parsed = JSON.parse(rules)
              } catch {
                setMsg('JSON aturan tidak valid')
                return
              }
              try {
                const next = await window.api.invoke('config:update', {
                  news: {
                    cryptoBiasMode: mode,
                    windowBeforeMin: before,
                    windowAfterMin: after,
                    newsStrategyEnabled: strategy,
                    rules: parsed as AppConfig['news']['rules']
                  }
                })
                onSaved(next)
                setRules(JSON.stringify(next.news.rules, null, 2))
                setMsg('Tersimpan')
              } catch (e) {
                setMsg(failMsg(e))
              }
            }}
          >
            Simpan news
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const { DEFAULT_RULES } = await import('@shared/config')
              setRules(JSON.stringify(DEFAULT_RULES, null, 2))
            }}
          >
            Reset ke default
          </Button>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

function BotSettings({ config, onSaved }: { config: AppConfig; onSaved: (c: AppConfig) => void }) {
  const [b, setB] = useState(config.bot)
  const [msg, setMsg] = useState<string | null>(null)
  // Keep the form in sync when config changes elsewhere (Bot page Start/Stop, other windows)
  useEffect(() => setB(config.bot), [config.bot])
  const num = (k: 'minScore' | 'minConfidence' | 'riskPerTradePct' | 'topVolume' | 'maxSetupAgeMin' | 'maxAnalysisAgeMin' | 'paperEquity', label: string, step: number) => (
    <>
      <Label htmlFor={`bot-${k}`}>{label}</Label>
      <Input id={`bot-${k}`} type="number" step={step} className="num text-right" value={b[k]} onChange={(e) => setB({ ...b, [k]: Number(e.target.value) })} />
    </>
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bot entry</CardTitle>
        <CardDescription>
          Start/stop dan saklar LIVE ada di halaman Bot. Entry cuma dari setup screener (model yang dicentang di bawah) di koin crypto top volume.
          Analisis Claude cuma wajib kalau "Claude wajib" dinyalakan di halaman Bot.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-[1fr_140px] items-center gap-3">
          {num('riskPerTradePct', 'Risk per order (% equity yang rela hilang kalau kena SL)', 0.1)}
          {num('minScore', 'Min skor setup (0 = mati; skor = 3 + jumlah konfluensi). Profil koin dari Backtest punya min skor sendiri', 1)}
          {num('minConfidence', 'Min confidence Claude (0–100, cuma dipakai kalau "Claude wajib" nyala)', 1)}
          {num('maxAnalysisAgeMin', 'Umur maks analisis Claude (menit)', 5)}
          {num('topVolume', 'Koin crypto top N volume 24 jam', 10)}
          {num('maxSetupAgeMin', 'Umur maks setup saat entry (menit)', 15)}
          {num('paperEquity', 'Modal akun paper (USDT)', 1)}
          <div className="col-span-2 space-y-1">
            <Label>Model entry yang boleh dipakai (minimal 1; profil koin dari Backtest punya model sendiri)</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {ENTRY_MODELS.map((m) => {
                const on = b.models.includes(m)
                return (
                  <label key={m} className="flex items-center gap-1" title={on && b.models.length === 1 ? 'Minimal satu model' : undefined}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={on && b.models.length === 1}
                      onChange={(e) =>
                        setB({ ...b, models: e.target.checked ? ENTRY_MODELS.filter((x) => x === m || b.models.includes(x)) : b.models.filter((x) => x !== m) })
                      }
                    />
                    {MODEL_LABEL[m]}
                  </label>
                )
              })}
            </div>
          </div>
          {(
            [
              ['requireConfluence', 'Konfluensi wajib untuk model SMC M0–M4 (semua yang dicentang harus ada; kosong = bebas)'],
              ['trendRequireConfluence', 'Konfluensi wajib untuk M5 trend (default: OI naik searah harga)']
            ] as const
          ).map(([field, title]) => (
            <div key={field} className="col-span-2 space-y-1">
              <Label>{title}</Label>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {CONFLUENCE_CHOICES.map(({ key, label }) => {
                  const k = key as (typeof b.requireConfluence)[number]
                  const list = b[field]
                  return (
                    <label key={key} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={list.includes(k)}
                        onChange={(e) => setB({ ...b, [field]: e.target.checked ? [...list, k] : list.filter((x) => x !== k) })}
                      />
                      {label}
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
          <Label>POI HTF yang dipakai</Label>
          <div className="flex justify-end gap-3 text-xs">
            {(['1h', '4h', '1d'] as const).map((tf) => (
              <label key={tf} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={b.poiTimeframes.includes(tf)}
                  onChange={(e) => setB({ ...b, poiTimeframes: e.target.checked ? [...b.poiTimeframes, tf] : b.poiTimeframes.filter((x) => x !== tf) })}
                />
                {tf}
              </label>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Ukuran posisi = equity × {b.riskPerTradePct}% ÷ jarak entry–SL (fee ikut dihitung). Contoh: equity 10 USDT, SL 0,5% dari entry → rugi maks{' '}
          {((10 * b.riskPerTradePct) / 100).toFixed(2)} USDT, ukuran posisi ≈ {((10 * b.riskPerTradePct) / 100 / 0.0068).toFixed(0)} USDT (dibatasi leverage maks{' '}
          {config.risk.maxLeverage}×). Order di bawah minimal Binance (biasanya 5 USDT, BTC 50, ETH 20) dilewati, bukan digedein.
        </p>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={async () => {
              try {
                // Only send fields changed in this form, so stale values never overwrite newer config
                const { enabled: _e, live: _l, ...all } = b
                const patch = Object.fromEntries(
                  Object.entries(all).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(config.bot[k as keyof typeof config.bot]))
                )
                const next = await window.api.invoke('config:update', { bot: patch })
                onSaved(next)
                setB(next.bot)
                setMsg('Tersimpan')
              } catch (e) {
                setMsg(failMsg(e))
              }
            }}
          >
            Simpan bot
          </Button>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

function ClaudeSettings({ config, onSaved }: { config: AppConfig; onSaved: (c: AppConfig) => void }) {
  const [c, setC] = useState(config.claude)
  const [msg, setMsg] = useState<string | null>(null)
  const num = (k: 'intervalMinutes' | 'maxBudgetUsd' | 'dailyBudgetUsd' | 'maxTurns', label: string, step: number) => (
    <>
      <Label htmlFor={k}>{label}</Label>
      <Input id={k} type="number" step={step} className="num w-28 text-right" value={c[k]} onChange={(e) => setC({ ...c, [k]: Number(e.target.value) })} />
    </>
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>Claude analis</CardTitle>
        <CardDescription>
          Lewat Claude Agent SDK, menjalankan Claude Code yang terinstal di komputer ini (tidak dibundel ke app). Hanya tool data read-only, tanpa tool file/bash/web, tidak bisa kirim order.
          Analisis cuma koin di watchlist. Anthropic API Key di atas opsional — kalau kosong, pakai login Claude Code di komputer ini.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {(
          [
            ['enabled', 'Aktif'],
            ['triggerOnNews', 'Jalan otomatis setelah actual news USD keluar']
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c[k]} onChange={(e) => setC({ ...c, [k]: e.target.checked })} />
            {label}
          </label>
        ))}
        <div className="grid grid-cols-[1fr_auto] items-center gap-3">
          <Label htmlFor="model">Model</Label>
          <Input id="model" className="num w-48" value={c.model} onChange={(e) => setC({ ...c, model: e.target.value })} />
          <Label htmlFor="exe">Path Claude Code (kosong = otomatis)</Label>
          <Input
            id="exe"
            className="num w-72"
            placeholder="otomatis: PATH / ~/.local/bin"
            value={c.executable}
            onChange={(e) => setC({ ...c, executable: e.target.value })}
          />
          <Label htmlFor="effort">Effort</Label>
          <select
            id="effort"
            className="h-9 w-48 rounded-md border border-input bg-transparent px-2 text-sm"
            value={c.effort}
            onChange={(e) => setC({ ...c, effort: e.target.value as typeof c.effort })}
          >
            {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          {num('intervalMinutes', 'Interval berkala (menit, 0 = mati)', 1)}
          {num('maxBudgetUsd', 'Batas biaya per run (USD)', 0.05)}
          {num('dailyBudgetUsd', 'Batas biaya per hari (USD)', 0.5)}
          {num('maxTurns', 'Maks turn per run', 1)}
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={async () => {
              try {
                const next = await window.api.invoke('config:update', { claude: c })
                onSaved(next)
                setC(next.claude)
                setMsg('Tersimpan')
              } catch (e) {
                setMsg(failMsg(e))
              }
            }}
          >
            Simpan Claude
          </Button>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
