const SUFFIX: Record<string, number> = { K: 1, M: 1, B: 1, T: 1 }

/**
 * Parse a ForexFactory value like "0.3%", "194K", "-1.2B", "<0.1%", "4.00%".
 * The unit suffix is dropped (forecast/actual of one event share the same unit), so "194K" → 194.
 * Returns null for empty / non-numeric strings.
 */
export function parseFfValue(raw: string | null | undefined): number | null {
  if (!raw) return null
  const m = raw.trim().replace(/,/g, '').match(/^[<>]?\s*([-+]?\d*\.?\d+)\s*([%KMBT])?$/i)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const suffix = m[2]?.toUpperCase()
  return suffix && suffix in SUFFIX ? n * SUFFIX[suffix]! : n
}

/** Strip control characters and cap length: feed text is displayed, never interpreted. */
export function cleanText(s: unknown, max = 200): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max)
}

/** Format an actual in the same style as the event's forecast/previous (unit suffix, decimals). */
export function formatLike(value: number, like: string | null, decimals: number): string {
  const unit = like?.trim().match(/([%KMBT])$/i)?.[1] ?? ''
  return `${value.toFixed(decimals)}${unit}`
}
