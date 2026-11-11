import { homedir } from 'node:os'
import { join } from 'node:path'

export const APP_DIR_NAME = 'smc-trading-assistant'

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

export const defaultDbPath = (): string => process.env.SMC_DB_PATH ?? join(userDataDir(), 'data', 'trading.db')
