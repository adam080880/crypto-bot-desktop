import { useEffect, useState } from 'react'
import { FolderOpen, HardDrive, RotateCcw } from 'lucide-react'
import type { StorageInfo } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { fmtBytes } from '@/lib/format'

type Plan = { dir: string; ok: boolean; error?: string; targetHasDb: boolean; needBytes: number; freeBytes: number | null }

export function StorageSettings() {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState<{ fraction: number; phase: string; error?: string } | null>(null)
  const [devNote, setDevNote] = useState(false)

  useEffect(() => {
    void window.api.invoke('storage:get').then(setInfo)
    return window.api.on('storage:progress', setBusy)
  }, [])

  const choose = async (dir?: string): Promise<void> => {
    const d = dir ?? (await window.api.invoke('storage:chooseDir'))
    if (!d) return
    setPlan({ dir: d, ...(await window.api.invoke('storage:plan', { dir: d })) })
  }

  const run = async (mode: 'move' | 'useExisting'): Promise<void> => {
    if (!plan) return
    const r = await window.api.invoke('storage:move', { dir: plan.dir, mode })
    if (!r.restarting) setDevNote(true)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4" /> Lokasi database
        </CardTitle>
        <CardDescription>
          Full backfill ±10 GB — bisa dipindah ke drive lain. App dan CLI <span className="num">data:backfill</span> memakai lokasi
          yang sama. Setelah pindah, app restart otomatis.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {info && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <div>
              File: <span className="num selectable text-foreground">{info.dbPath}</span>
              {info.isDefault && <span className="ml-2">(default)</span>}
            </div>
            <div>
              Ukuran: <span className="num text-foreground">{fmtBytes(info.dbBytes)}</span> · sisa disk:{' '}
              <span className="num text-foreground">{fmtBytes(info.freeBytes)}</span>
            </div>
            {info.envOverride && <div className="text-warn">Dikunci oleh environment variable SMC_DB_PATH.</div>}
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={!info || info.envOverride} onClick={() => void choose()}>
            <FolderOpen /> Pindahkan…
          </Button>
          {info && !info.isDefault && !info.envOverride && (
            <Button size="sm" variant="ghost" onClick={() => void choose(info.defaultDir)}>
              <RotateCcw /> Kembalikan ke default
            </Button>
          )}
        </div>
      </CardContent>

      <Dialog open={!!plan} onOpenChange={(o) => !o && !busy && setPlan(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{busy ? 'Memindahkan database…' : 'Pindahkan database?'}</DialogTitle>
            <DialogDescription className="num selectable break-all">{plan?.dir}</DialogDescription>
          </DialogHeader>
          {busy ? (
            <div className="space-y-2 text-sm">
              <Progress value={busy.fraction * 100} />
              <div className="text-xs text-muted-foreground">
                {busy.phase === 'stopping' && 'Menghentikan sync & live data…'}
                {busy.phase === 'copying' && `Menyalin… ${Math.round(busy.fraction * 100)}%`}
                {busy.phase === 'restarting' && (devNote ? 'Selesai. Mode dev: jalankan ulang `pnpm dev`.' : 'Selesai, app restart…')}
                {busy.phase === 'error' && <span className="text-bear">Gagal: {busy.error} — tetap memakai lokasi lama, app restart…</span>}
              </div>
            </div>
          ) : plan ? (
            <div className="space-y-2 text-sm">
              {plan.targetHasDb ? (
                <p>
                  Folder ini <b>sudah berisi trading.db</b>. Pakai database itu? Database di lokasi sekarang tidak dihapus.
                </p>
              ) : plan.ok ? (
                <p className="text-muted-foreground">
                  Sync & live data dihentikan sebentar, database (<span className="num">{fmtBytes(plan.needBytes)}</span>) disalin
                  lalu file lama dihapus setelah salinan terverifikasi. Sisa disk tujuan:{' '}
                  <span className="num">{fmtBytes(plan.freeBytes)}</span>.
                </p>
              ) : (
                <p className="text-bear">{plan.error}</p>
              )}
            </div>
          ) : null}
          {!busy && (
            <DialogFooter>
              <Button variant="ghost" onClick={() => setPlan(null)}>
                Batal
              </Button>
              {plan?.targetHasDb ? (
                <Button onClick={() => void run('useExisting')}>Pakai yang sudah ada</Button>
              ) : (
                <Button disabled={!plan?.ok} onClick={() => void run('move')}>
                  Pindahkan & restart
                </Button>
              )}
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
