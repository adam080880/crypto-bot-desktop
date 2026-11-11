export function fmtBytes(b: number | null | undefined): string {
  if (b == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024
    i++
  }
  return `${b.toFixed(i ? 2 : 0)} ${u[i]}`
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}j ${m}m` : m ? `${m}m ${s % 60}dtk` : `${s}dtk`
}

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('id-ID')
