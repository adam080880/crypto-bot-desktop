import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findClaude } from './findClaude'

describe('findClaude', () => {
  it('uses an explicit path, then PATH (per platform)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-'))
    writeFileSync(join(dir, 'claude'), '')
    writeFileSync(join(dir, 'claude.exe'), '')
    expect(findClaude(join(dir, 'claude'))).toBe(join(dir, 'claude'))
    expect(findClaude('/nope/claude')).toBeNull()
    expect(findClaude('', { PATH: dir }, 'darwin')).toBe(join(dir, 'claude'))
    expect(findClaude('', { Path: dir }, 'win32')).toBe(join(dir, 'claude.exe'))
  })
})
