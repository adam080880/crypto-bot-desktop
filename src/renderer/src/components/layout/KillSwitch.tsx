import { useState } from 'react'
import { OctagonX, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { useAppStore } from '@/stores/appStore'

export function KillSwitch() {
  const status = useAppStore((s) => s.status)
  const setStatus = useAppStore((s) => s.setStatus)
  const [open, setOpen] = useState(false)
  const active = status?.killSwitch.active ?? false

  if (active) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="no-drag border-destructive/60 text-destructive">
            <Play /> HALTED · Resume
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lanjutkan bot?</DialogTitle>
            <DialogDescription>Kill switch akan dimatikan dan bot boleh beroperasi lagi sesuai mode saat ini.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Batal</Button>
            </DialogClose>
            <Button
              onClick={async () => {
                setStatus(await window.api.invoke('bot:resume'))
                setOpen(false)
              }}
            >
              Resume
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm" className="no-drag font-semibold">
          <OctagonX /> KILL SWITCH
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-destructive">Aktifkan Kill Switch?</DialogTitle>
          <DialogDescription>
            Bot berhenti total: tidak ada posisi baru yang dibuka sampai kamu resume manual. Status ini tetap
            tersimpan walau app di-restart.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Batal</Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={async () => {
              setStatus(await window.api.invoke('bot:killSwitch'))
              setOpen(false)
            }}
          >
            Ya, hentikan bot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
