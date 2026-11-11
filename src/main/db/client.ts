import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database }

export interface OpenDbOptions {
  path: string
  migrationsFolder: string
  readonly?: boolean
}

/**
 * Open the SQLite database with pragmas tuned for bulk candle writes, then apply migrations.
 * Electron-free so the CLI and tests can use it too.
 */
export function openDatabase({ path, migrationsFolder, readonly = false }: OpenDbOptions): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path, { readonly })
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('temp_store = MEMORY')
  sqlite.pragma('cache_size = -65536') // 64 MiB
  const db = drizzle(sqlite, { schema }) as Db
  if (!readonly) migrate(db, { migrationsFolder })
  return db
}
