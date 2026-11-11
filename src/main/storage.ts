import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { StorageInfo } from '@shared/ipc'
import type { Db } from './db/client'
import { logger } from './logger'
import { DB_FILE, dbExistsIn, dbPathFromEnv, defaultDataDir, readCustomDataDir, writeCustomDataDir } from './userDataDir'

const log = logger('storage')

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

async function sizeOf(p: string): Promise<number> {
  try {
    return (await stat(p)).size
  } catch {
    return 0
  }
}

/** Nearest existing ancestor (for free-space checks on folders that don't exist yet). */
async function existingAncestor(dir: string): Promise<string> {
  let d = dir
  for (;;) {
    try {
      await stat(d)
      return d
    } catch {
      const up = dirname(d)
      if (up === d) return d
      d = up
    }
  }
}

export async function storageInfo(dbPath: string): Promise<StorageInfo> {
  const dir = dirname(dbPath)
  const dbBytes = (await sizeOf(dbPath)) + (await sizeOf(`${dbPath}-wal`))
  return {
    dbPath,
    dataDir: dir,
    isDefault: !dbPathFromEnv() && readCustomDataDir() === null,
    defaultDir: defaultDataDir(),
    envOverride: dbPathFromEnv(),
    dbBytes,
    freeBytes: await freeBytes(dir)
  }
}

export interface PlanResult {
  ok: boolean
  error?: string
  targetHasDb: boolean
  needBytes: number
  freeBytes: number | null
}

/** Validate a target folder before moving. */
export async function planMove(currentDbPath: string, targetDir: string): Promise<PlanResult> {
  const needBytes = (await sizeOf(currentDbPath)) + (await sizeOf(`${currentDbPath}-wal`))
  const fail = (error: string): PlanResult => ({ ok: false, error, targetHasDb: false, needBytes, freeBytes: null })
  if (dbPathFromEnv()) return fail('Lokasi DB dikunci oleh environment variable SMC_DB_PATH.')
  if (!isAbsolute(targetDir)) return fail('Folder harus path absolut.')
  const target = resolve(targetDir)
  if (target === resolve(dirname(currentDbPath))) return fail('Itu folder yang sama dengan lokasi sekarang.')
  try {
    await mkdir(target, { recursive: true })
    const probe = join(target, `.smc-write-test-${process.pid}`)
    await writeFile(probe, 'ok')
    await unlink(probe)
  } catch (e) {
    return fail(`Folder tidak bisa ditulis: ${(e as Error).message}`)
  }
  const free = await freeBytes(await existingAncestor(target))
  const targetHasDb = dbExistsIn(target)
  if (!targetHasDb && free !== null && free < needBytes * 1.1)
    return { ok: false, error: 'Ruang disk di tujuan tidak cukup.', targetHasDb, needBytes, freeBytes: free }
  return { ok: true, targetHasDb, needBytes, freeBytes: free }
}

/**
 * Move (or switch) the database. Caller must have stopped the data worker first.
 *  mode 'move'        → checkpoint + close, copy with progress, verify size, point to new, delete old
 *  mode 'useExisting' → target already has trading.db: just point to it (old files untouched)
 * On failure nothing is switched (location.json unchanged) and partial copies are removed.
 */
export async function moveDatabase(
  db: Db,
  currentDbPath: string,
  targetDir: string,
  mode: 'move' | 'useExisting',
  onProgress: (fraction: number) => void
): Promise<void> {
  const target = resolve(targetDir)
  const dest = join(target, DB_FILE)
  // flush WAL into the main file so a single-file copy is complete
  db.$client.pragma('wal_checkpoint(TRUNCATE)')
  db.$client.close()

  const toDefault = resolve(target) === resolve(defaultDataDir())
  if (mode === 'useExisting') {
    if (!dbExistsIn(target)) throw new Error('trading.db tidak ada di folder tujuan')
    writeCustomDataDir(toDefault ? null : target)
    log.info({ target }, 'switched to existing database')
    return
  }
  if (dbExistsIn(target)) throw new Error('Folder tujuan sudah berisi trading.db — pilih "pakai yang sudah ada" atau folder lain.')

  const total = await sizeOf(currentDbPath)
  let done = 0
  let lastEmit = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length
      const now = Date.now()
      if (now - lastEmit > 200) {
        lastEmit = now
        onProgress(total ? done / total : 1)
      }
      cb(null, chunk)
    }
  })
  const tmp = `${dest}.partial`
  try {
    await pipeline(createReadStream(currentDbPath), meter, createWriteStream(tmp))
    if ((await sizeOf(tmp)) !== total) throw new Error('ukuran salinan tidak cocok')
    const { rename } = await import('node:fs/promises')
    await rename(tmp, dest)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  onProgress(1)
  writeCustomDataDir(toDefault ? null : target)
  log.info({ from: currentDbPath, to: dest, bytes: total }, 'database moved')
  // remove the old copy only after the new location is recorded
  for (const f of [currentDbPath, `${currentDbPath}-wal`, `${currentDbPath}-shm`]) await rm(f, { force: true })
}
