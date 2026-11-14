import { z } from 'zod'

/**
 * Output contract for one Claude analysis (spec Fase 6). Anything that fails validation is
 * stored as `skip` — never acted upon.
 */
export const analysisItemSchema = z
  .object({
    symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
    bias: z.enum(['long', 'short', 'skip']),
    /** 0–100 */
    confidence: z.number().min(0).max(100),
    reasons: z.array(z.string().min(1).max(400)).min(1).max(8),
    key_levels: z.array(z.object({ price: z.number().positive(), label: z.string().min(1).max(80) }).strict()).max(10),
    invalidation: z.object({ price: z.number().positive().nullable(), reason: z.string().min(1).max(300) }).strict()
  })
  .strict()
export type AnalysisItem = z.infer<typeof analysisItemSchema>

export const analysisOutputSchema = z
  .object({
    analyses: z.array(analysisItemSchema).min(1).max(20),
    market_note: z.string().max(600)
  })
  .strict()
export type AnalysisOutput = z.infer<typeof analysisOutputSchema>

/** bot = requested by the Fase 7 bot for fresh setups on specific symbols. */
export type AnalysisTrigger = 'news' | 'manual' | 'interval' | 'bot'
export type RunStatus = 'ok' | 'invalid' | 'error' | 'budget'

export interface ClaudeRun {
  id: string
  createdAt: number
  finishedAt: number | null
  trigger: AnalysisTrigger
  /** Economic events that triggered the run (news trigger). */
  eventTitles: string[]
  model: string
  status: RunStatus | 'running'
  error: string | null
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  marketNote: string | null
}

export interface ClaudeAnalysis extends AnalysisItem {
  id: string
  runId: string
  createdAt: number
  /** Price when the analysis was requested. */
  price: number | null
  /** True when the model's output failed validation and was forced to skip. */
  forcedSkip: boolean
}

export interface ClaudeState {
  running: boolean
  lastRunAt: number | null
  lastError: string | null
  costTodayUsd: number
  costMonthUsd: number
}
