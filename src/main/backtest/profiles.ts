import { z } from 'zod'
import type { CoinProfile } from '@shared/backtest'
import type { Db } from '../db/client'
import { readSetting, writeSetting } from '../db/settingsRepo'

const KEY = 'coin_profiles'
const anyRecord = z.record(z.string(), z.custom<CoinProfile>((v) => typeof v === 'object' && v !== null))

/** Coin profiles chosen in the backtest "Meta" table (symbol → profile). */
export function readProfiles(db: Db): Record<string, CoinProfile> {
  return readSetting(db, KEY, anyRecord) ?? {}
}

export function saveProfile(db: Db, p: CoinProfile): Record<string, CoinProfile> {
  const all = { ...readProfiles(db), [p.symbol]: p }
  writeSetting(db, KEY, all)
  return all
}

export function deleteProfile(db: Db, symbol: string): Record<string, CoinProfile> {
  const { [symbol]: _gone, ...rest } = readProfiles(db)
  writeSetting(db, KEY, rest)
  return rest
}
