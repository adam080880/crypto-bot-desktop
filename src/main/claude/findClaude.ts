import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Locate the user's installed Claude Code CLI (the app does not bundle it).
 * Order: explicit path from Settings → PATH → standard install locations.
 * GUI-launched apps (Finder / Start menu) often get a minimal PATH, hence the fallbacks.
 */
export function findClaude(explicit = '', env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  if (explicit.trim()) return existsSync(explicit.trim()) ? explicit.trim() : null
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  const home = homedir()
  if (platform === 'win32') {
    const up = env.USERPROFILE ?? home
    dirs.push(join(up, '.local', 'bin'), join(env.APPDATA ?? join(up, 'AppData', 'Roaming'), 'npm'), join(env.LOCALAPPDATA ?? join(up, 'AppData', 'Local'), 'Programs', 'claude'))
  } else {
    dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin'))
  }
  for (const d of dirs) for (const n of names) {
    const p = join(d, n)
    if (existsSync(p)) return p
  }
  return null
}
