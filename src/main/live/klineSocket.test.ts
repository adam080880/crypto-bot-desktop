import { describe, expect, it } from 'vitest'
import { partition } from './klineSocket'

describe('partition', () => {
  it('fills connections up to perConn and keeps existing assignments', () => {
    const first = partition(['A', 'B', 'C', 'D', 'E'], [], 2)
    expect(first).toEqual([['A', 'B'], ['C', 'D'], ['E']])
    const next = partition(['B', 'C', 'D', 'E', 'F', 'G'], first, 2)
    expect(next).toEqual([['B', 'F'], ['C', 'D'], ['E', 'G']])
  })
})
