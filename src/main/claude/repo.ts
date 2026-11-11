import { desc, eq, gte } from 'drizzle-orm'
import type { AnalysisItem, AnalysisTrigger, ClaudeAnalysis, ClaudeRun, RunStatus } from '@shared/claude'
import type { Db } from '../db/client'
import { claudeAnalyses, claudeRuns } from '../db/schema'

export class ClaudeRepo {
  constructor(private readonly db: Db) {}

  startRun(id: string, trigger: AnalysisTrigger, eventTitles: string[], model: string): void {
    this.db
      .insert(claudeRuns)
      .values({ id, createdAt: Date.now(), trigger, eventTitles: JSON.stringify(eventTitles), model, status: 'running' })
      .run()
  }

  finishRun(
    id: string,
    r: { status: RunStatus; error?: string | null; costUsd?: number | null; inputTokens?: number | null; outputTokens?: number | null; marketNote?: string | null }
  ): void {
    this.db
      .update(claudeRuns)
      .set({
        finishedAt: Date.now(),
        status: r.status,
        error: r.error ?? null,
        costUsd: r.costUsd ?? null,
        inputTokens: r.inputTokens ?? null,
        outputTokens: r.outputTokens ?? null,
        marketNote: r.marketNote ?? null
      })
      .where(eq(claudeRuns.id, id))
      .run()
  }

  addAnalysis(runId: string, item: AnalysisItem, price: number | null, forcedSkip: boolean): void {
    this.db
      .insert(claudeAnalyses)
      .values({
        id: `${runId}-${item.symbol}`,
        runId,
        createdAt: Date.now(),
        symbol: item.symbol,
        bias: item.bias,
        confidence: item.confidence,
        price,
        forcedSkip,
        payload: JSON.stringify(item)
      })
      .onConflictDoNothing()
      .run()
  }

  runs(limit = 30): ClaudeRun[] {
    return this.db
      .select()
      .from(claudeRuns)
      .orderBy(desc(claudeRuns.createdAt))
      .limit(limit)
      .all()
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        trigger: r.trigger as AnalysisTrigger,
        eventTitles: JSON.parse(r.eventTitles) as string[],
        model: r.model,
        status: r.status as ClaudeRun['status'],
        error: r.error,
        costUsd: r.costUsd,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        marketNote: r.marketNote
      }))
  }

  analyses(limit = 60): ClaudeAnalysis[] {
    return this.db
      .select()
      .from(claudeAnalyses)
      .orderBy(desc(claudeAnalyses.createdAt))
      .limit(limit)
      .all()
      .map((r) => ({
        ...(JSON.parse(r.payload) as AnalysisItem),
        id: r.id,
        runId: r.runId,
        createdAt: r.createdAt,
        price: r.price,
        forcedSkip: r.forcedSkip
      }))
  }

  costSince(t: number): number {
    return this.db
      .select({ c: claudeRuns.costUsd })
      .from(claudeRuns)
      .where(gte(claudeRuns.createdAt, t))
      .all()
      .reduce((a, r) => a + (r.c ?? 0), 0)
  }

  /** Runs left as 'running' by a crash/quit are closed on startup. */
  closeDangling(): void {
    this.db
      .update(claudeRuns)
      .set({ status: 'error', error: 'dihentikan (app ditutup)', finishedAt: Date.now() })
      .where(eq(claudeRuns.status, 'running'))
      .run()
  }
}
