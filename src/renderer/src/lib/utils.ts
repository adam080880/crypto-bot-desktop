import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatTime(ms: number | null): string {
  if (ms == null) return '—'
  return new Date(ms).toLocaleString('id-ID', { hour12: false })
}
