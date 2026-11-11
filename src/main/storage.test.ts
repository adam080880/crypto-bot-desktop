import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from './db/client'
import { writeSetting, readSetting } from './db/settingsRepo'
import { moveDatabase, planMove } from './storage'
import { defaultDbPath, locationFile } from './userDataDir'
import { z } from 'zod'

describe('database location', () => {
  let ud: string
  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), 'smc-ud-'))
    process.env.SMC_USER_DATA = ud
    delete process.env.SMC_DB_PATH
  })
  afterEach(() => {
    delete process.env.SMC_USER_DATA
  })

  it('moves the DB, records the new location, removes the old file; CLI path follows', async () => {
    const oldPath = defaultDbPath()
    expect(oldPath).toBe(join(ud, 'data', 'trading.db'))
    const db = openDatabase({ path: oldPath, migrationsFolder: join(process.cwd(), 'drizzle') })
    writeSetting(db, 'marker', 42) // lands in the WAL; the move must checkpoint it
    const target = mkdtempSync(join(tmpdir(), 'smc-target-'))
    const plan = await planMove(oldPath, target)
    expect(plan).toMatchObject({ ok: true, targetHasDb: false })

    const seen: number[] = []
    await moveDatabase(db, oldPath, target, 'move', (f) => seen.push(f))
    expect(seen.at(-1)).toBe(1)
    expect(existsSync(oldPath)).toBe(false)
    expect(JSON.parse(readFileSync(locationFile(), 'utf8'))).toEqual({ dataDir: target })
    expect(defaultDbPath()).toBe(join(target, 'trading.db'))

    const moved = openDatabase({ path: defaultDbPath(), migrationsFolder: join(process.cwd(), 'drizzle') })
    expect(readSetting(moved, 'marker', z.number())).toBe(42)
    moved.$client.close()

    // a folder that already has trading.db is offered as "use existing"
    expect(await planMove(join(ud, 'data', 'x.db'), target)).toMatchObject({ targetHasDb: true })
  })

  it('refuses when SMC_DB_PATH pins the location', async () => {
    process.env.SMC_DB_PATH = join(ud, 'pinned.db')
    expect((await planMove(process.env.SMC_DB_PATH, mkdtempSync(join(tmpdir(), 'x-')))).ok).toBe(false)
    delete process.env.SMC_DB_PATH
  })
})
