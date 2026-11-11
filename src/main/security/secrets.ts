import { eq } from 'drizzle-orm'
import { safeStorage } from 'electron'
import { SECRET_NAMES, type SecretName, type SecretStatus } from '@shared/ipc'
import type { Db } from '../db/client'
import { secrets } from '../db/schema'
import { logger } from '../logger'

const log = logger('secrets')

export class SecretStore {
  constructor(private readonly db: Db) {}

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  set(name: SecretName, value: string): void {
    if (!this.isEncryptionAvailable()) {
      throw new Error('OS encryption (safeStorage) tidak tersedia; secret tidak disimpan.')
    }
    const ciphertext = safeStorage.encryptString(value)
    const now = Date.now()
    this.db
      .insert(secrets)
      .values({ name, ciphertext, updatedAt: now })
      .onConflictDoUpdate({ target: secrets.name, set: { ciphertext, updatedAt: now } })
      .run()
    log.info({ name }, 'secret stored') // never log the value
  }

  /** Main-process only. Never expose the return value over IPC. */
  get(name: SecretName): string | null {
    const row = this.db.select().from(secrets).where(eq(secrets.name, name)).get()
    if (!row) return null
    try {
      return safeStorage.decryptString(row.ciphertext)
    } catch (err) {
      log.error({ name, err: (err as Error).message }, 'failed to decrypt secret')
      return null
    }
  }

  delete(name: SecretName): void {
    this.db.delete(secrets).where(eq(secrets.name, name)).run()
    log.info({ name }, 'secret deleted')
  }

  list(): SecretStatus[] {
    const rows = this.db.select({ name: secrets.name, updatedAt: secrets.updatedAt }).from(secrets).all()
    const byName = new Map(rows.map((r) => [r.name, r.updatedAt]))
    return SECRET_NAMES.map((name) => ({
      name,
      stored: byName.has(name),
      updatedAt: byName.get(name) ?? null
    }))
  }
}
