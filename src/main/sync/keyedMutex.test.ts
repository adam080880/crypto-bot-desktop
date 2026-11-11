import { describe, expect, it } from 'vitest'
import { KeyedMutex } from './keyedMutex'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('KeyedMutex', () => {
  it('serialises per key and keeps going after errors', async () => {
    const m = new KeyedMutex()
    const order: string[] = []
    const a = m.run('X', async () => {
      await tick(20)
      order.push('a')
    })
    const b = m.run('X', async () => {
      order.push('b')
      throw new Error('boom')
    })
    const c = m.run('X', async () => order.push('c'))
    const other = m.run('Y', async () => order.push('y'))
    await Promise.allSettled([a, b, c, other])
    expect(order).toEqual(['y', 'a', 'b', 'c'])
    await expect(b).rejects.toThrow('boom')
  })
})
