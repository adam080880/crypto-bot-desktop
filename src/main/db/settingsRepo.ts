import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { Db } from './client'
import { settings } from './schema'

export function readSetting<T extends z.ZodTypeAny>(db: Db, key: string, schema: T): z.infer<T> | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  if (!row) return null
  try {
    const parsed = schema.safeParse(JSON.parse(row.value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeSetting(db: Db, key: string, value: unknown): void {
  const now = Date.now()
  db.insert(settings)
    .values({ key, value: JSON.stringify(value), updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt: now } })
    .run()
}
