import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export const APP_DIR_NAME = 'smc-trading-assistant'
export const DB_FILE = 'trading.db'

/** userData directory, computed without Electron so the CLI resolves the same DB as the app. */
export function userDataDir(): string {
  if (process.env.SMC_USER_DATA) return process.env.SMC_USER_DATA
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME)
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), APP_DIR_NAME)
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), APP_DIR_NAME)
  }
}

export const defaultDataDir = (): string => join(userDataDir(), 'data')
/** Small bootstrap file (outside the DB, which can't store its own location). */
export const locationFile = (): string => join(userDataDir(), 'location.json')

/** Custom data folder chosen in Settings, or null for the default. */
export function readCustomDataDir(): string | null {
  try {
    const raw = JSON.parse(readFileSync(locationFile(), 'utf8')) as { dataDir?: unknown }
    return typeof raw.dataDir === 'string' && isAbsolute(raw.dataDir) ? raw.dataDir : null
  } catch {
    return null
  }
}

export function writeCustomDataDir(dir: string | null): void {
  mkdirSync(dirname(locationFile()), { recursive: true })
  writeFileSync(locationFile(), JSON.stringify(dir ? { dataDir: dir } : {}, null, 2))
}

/** True when SMC_DB_PATH overrides everything (Settings can't change it then). */
export const dbPathFromEnv = (): boolean => !!process.env.SMC_DB_PATH

/** Resolution order: SMC_DB_PATH → location.json (Settings) → <userData>/data/trading.db. */
export const defaultDbPath = (): string =>
  process.env.SMC_DB_PATH ?? join(readCustomDataDir() ?? defaultDataDir(), DB_FILE)

export const dbExistsIn = (dir: string): boolean => existsSync(join(dir, DB_FILE))
