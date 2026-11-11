import { analysisItemSchema, analysisOutputSchema, type AnalysisItem } from '@shared/claude'

export interface Validated {
  items: { item: AnalysisItem; forcedSkip: boolean }[]
  marketNote: string | null
  valid: boolean
}

const skip = (symbol: string, reason: string): AnalysisItem => ({
  symbol,
  bias: 'skip',
  confidence: 0,
  reasons: [reason],
  key_levels: [],
  invalidation: { price: null, reason: 'tidak ada analisis valid' }
})

/**
 * Spec: Claude output must be structured JSON validated with zod; anything invalid → skip.
 * Validates per symbol so one bad entry doesn't discard the rest; symbols that weren't
 * requested are dropped, requested ones that are missing become skip.
 */
export function validateOutput(raw: unknown, requested: readonly string[]): Validated {
  const whole = analysisOutputSchema.safeParse(raw)
  const out: Validated['items'] = []
  let marketNote: string | null = null
  const candidates: unknown[] =
    whole.success ? whole.data.analyses : Array.isArray((raw as { analyses?: unknown })?.analyses) ? (raw as { analyses: unknown[] }).analyses : []
  if (whole.success) marketNote = whole.data.market_note
  const seen = new Set<string>()
  for (const c of candidates) {
    const p = analysisItemSchema.safeParse(c)
    const sym = (c as { symbol?: unknown })?.symbol
    if (!p.success) {
      if (typeof sym === 'string' && requested.includes(sym) && !seen.has(sym)) {
        seen.add(sym)
        out.push({ item: skip(sym, 'output Claude gagal validasi → dipaksa skip'), forcedSkip: true })
      }
      continue
    }
    if (!requested.includes(p.data.symbol) || seen.has(p.data.symbol)) continue
    seen.add(p.data.symbol)
    out.push({ item: p.data, forcedSkip: false })
  }
  for (const s of requested) if (!seen.has(s)) out.push({ item: skip(s, 'tidak ada analisis valid dari Claude untuk simbol ini'), forcedSkip: true })
  return { items: out, marketNote, valid: whole.success }
}
