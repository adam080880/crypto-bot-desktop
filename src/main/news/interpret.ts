import type { InterpretationRule, NewsConfig } from '@shared/config'
import type { Bias } from '@shared/news'

/** First rule whose regex matches the title (case-insensitive). Invalid regexes are skipped. */
export function findRule(title: string, rules: readonly InterpretationRule[]): InterpretationRule | null {
  for (const r of rules) {
    try {
      if (new RegExp(r.match, 'i').test(title)) return r
    } catch {
      /* bad user regex: ignore */
    }
  }
  return null
}

export interface Interpretation {
  usdBias: Bias
  cryptoBias: Bias
  reason: string
}

/**
 * Compare actual with forecast (or previous when there is no forecast).
 * higherIsGoodForUsd=false inverts (e.g. Unemployment Rate / Claims higher = bad for USD).
 * Crypto bias follows `cryptoBiasMode` (default inverse: USD bearish → crypto bullish).
 */
export function interpret(
  actual: number,
  forecast: number | null,
  previous: number | null,
  rule: InterpretationRule,
  mode: NewsConfig['cryptoBiasMode']
): Interpretation {
  const ref = forecast ?? previous
  if (ref === null) return { usdBias: 'neutral', cryptoBias: 'neutral', reason: 'tidak ada forecast/previous untuk dibandingkan' }
  const diff = actual - ref
  const vs = forecast !== null ? 'forecast' : 'previous'
  if (Math.abs(diff) <= rule.threshold + 1e-12) {
    return { usdBias: 'neutral', cryptoBias: 'neutral', reason: `actual = ${vs} (${actual} vs ${ref})` }
  }
  const higher = diff > 0
  const usdBias: Bias = higher === rule.higherIsGoodForUsd ? 'bullish' : 'bearish'
  const cryptoBias: Bias =
    mode === 'off' ? 'neutral' : mode === 'same' ? usdBias : usdBias === 'bullish' ? 'bearish' : 'bullish'
  const dirTxt = higher ? 'lebih tinggi' : 'lebih rendah'
  const inv = rule.higherIsGoodForUsd ? '' : ' (aturan terbalik)'
  return {
    usdBias,
    cryptoBias,
    reason: `actual ${actual} ${dirTxt} dari ${vs} ${ref} → USD ${usdBias}${inv}; crypto ${cryptoBias} (mode ${mode})`
  }
}
