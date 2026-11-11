import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrainCircuit, Play } from 'lucide-react'
import type { ClaudeAnalysis, ClaudeRun } from '@shared/claude'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { cn, formatTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

const px = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))
const usd = (n: number | null | undefined): string => (n == null ? '—' : `$${n.toFixed(n < 0.1 ? 4 : 2)}`)
const TRIGGER: Record<string, string> = { news: 'news', manual: 'manual', interval: 'berkala' }

function AnalysisCard({ a, run }: { a: ClaudeAnalysis; run: ClaudeRun | undefined }) {
  const tone = a.bias === 'long' ? 'bull' : a.bias === 'short' ? 'bear' : 'outline'
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="num">{a.symbol}</span>
          <Badge variant={tone}>{a.bias.toUpperCase()}</Badge>
          {a.forcedSkip && <Badge variant="warn">dipaksa skip</Badge>}
          <span className="num ml-auto text-xs font-normal text-muted-foreground">{formatTime(a.createdAt)}</span>
        </CardTitle>
        <CardDescription>
          {run ? `pemicu: ${TRIGGER[run.trigger]}${run.eventTitles.length ? ` (${run.eventTitles.join(', ')})` : ''}` : ''}
          {a.price != null && <> · harga saat analisis <span className="num">{px(a.price)}</span></>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <span className="w-24 text-xs text-muted-foreground">confidence</span>
          <Progress value={a.confidence} className="h-1.5 flex-1" />
          <span className="num w-10 text-right text-xs">{Math.round(a.confidence)}</span>
        </div>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {a.reasons.map((r) => (
            <li key={r} className="selectable">
              {r}
            </li>
          ))}
        </ul>
        {a.key_levels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {a.key_levels.map((k) => (
              <span key={`${k.label}${k.price}`} className="num rounded border px-1.5 py-0.5 text-[11px]">
                {k.label} <span className="text-foreground">{px(k.price)}</span>
              </span>
            ))}
          </div>
        )}
        <div className="text-xs">
          <span className="text-muted-foreground">Invalidation: </span>
          {a.invalidation.price != null && <span className="num text-bear">{px(a.invalidation.price)} · </span>}
          <span className="text-muted-foreground">{a.invalidation.reason}</span>
        </div>
      </CardContent>
    </Card>
  )
}

export function Analyses() {
  const st = useAppStore((s) => s.status?.claude)
  const [runs, setRuns] = useState<ClaudeRun[]>([])
  const [analyses, setAnalyses] = useState<ClaudeAnalysis[]>([])

  const load = useCallback(async () => {
    const r = await window.api.invoke('claude:list')
    setRuns(r.runs)
    setAnalyses(r.analyses)
  }, [])
  useEffect(() => {
    void load()
    return window.api.on('claude:changed', () => void load())
  }, [load])

  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs])
  const latestRun = runs.find((r) => r.status !== 'running')
  const latest = analyses.filter((a) => a.runId === latestRun?.id)

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Claude Analyses</h1>
        <span className="text-xs text-muted-foreground">read-only · tidak pernah mengirim order · dipicu news / manual</span>
        <Button size="sm" className="ml-auto" disabled={st?.running} onClick={() => window.api.invoke('claude:run')}>
          {st?.running ? <BrainCircuit className="animate-pulse" /> : <Play />}
          {st?.running ? 'Claude sedang menganalisa…' : 'Analisa sekarang'}
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4 text-xs">
        <Card>
          <CardContent className="pt-4">
            <div className="text-muted-foreground">Biaya hari ini</div>
            <div className="num text-xl">{usd(st?.costTodayUsd)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-muted-foreground">Biaya bulan ini</div>
            <div className="num text-xl">{usd(st?.costMonthUsd)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-muted-foreground">Run terakhir</div>
            <div className="num text-xl">{formatTime(st?.lastRunAt ?? null)}</div>
            {st?.lastError && <div className="mt-1 text-bear">{st.lastError}</div>}
          </CardContent>
        </Card>
      </div>

      {latestRun?.marketNote && (
        <Card>
          <CardContent className="selectable pt-4 text-sm text-muted-foreground">{latestRun.marketNote}</CardContent>
        </Card>
      )}

      {latest.length === 0 ? (
        <Card>
          <CardContent className="pt-4 text-sm text-muted-foreground">
            Belum ada analisis. Otomatis jalan setelah actual news USD keluar, atau tekan “Analisa sekarang”.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {latest.map((a) => (
            <AnalysisCard key={a.id} a={a} run={runById.get(a.runId)} />
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Riwayat run</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="num w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                {['waktu', 'pemicu', 'model', 'status', 'hasil', 'token in/out', 'biaya'].map((h) => (
                  <th key={h} className="px-2 py-1 text-left font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const items = analyses.filter((a) => a.runId === r.id)
                return (
                  <tr key={r.id} className="border-t border-border/50" title={r.error ?? ''}>
                    <td className="px-2 py-1">{formatTime(r.createdAt)}</td>
                    <td className="px-2">{TRIGGER[r.trigger]}</td>
                    <td className="px-2">{r.model}</td>
                    <td className={cn('px-2', r.status === 'ok' ? 'text-bull' : r.status === 'running' ? 'text-warn' : 'text-bear')}>{r.status}</td>
                    <td className="px-2">{items.map((a) => `${a.symbol.replace('USDT', '')} ${a.bias}`).join(' · ') || '—'}</td>
                    <td className="px-2">
                      {r.inputTokens ?? '—'} / {r.outputTokens ?? '—'}
                    </td>
                    <td className="px-2">{usd(r.costUsd)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
