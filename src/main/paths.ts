import { join } from 'node:path'
import { app } from 'electron'
import { defaultDbPath, userDataDir } from './userDataDir'

/** Pin userData to the same folder the CLI uses (dev and packaged alike). Call before 'ready'. */
export function pinUserData(): void {
  app.setPath('userData', userDataDir())
}

export const paths = {
  userData: () => app.getPath('userData'),
  db: defaultDbPath,
  logs: () => join(app.getPath('userData'), 'logs'),
  docs: () => (app.isPackaged ? join(process.resourcesPath, 'docs') : join(app.getAppPath(), 'docs')),
  claudeWorkDir: () => join(app.getPath('userData'), 'claude-workdir'),
  migrations: () =>
    app.isPackaged ? join(process.resourcesPath, 'drizzle') : join(app.getAppPath(), 'drizzle')
}
