import type { ConnCheck, ConnTestResult } from '@shared/bot'
import { BinanceApiError, BinanceTradeClient } from '../bot/binanceTrade'
import { FAPI_BASE } from '../exchange/binanceFutures'
import { MARKET_WS } from '../live/klineSocket'
import { resolveHost } from './dns'

const msg = (err: unknown): string => {
  const e = err as Error & { cause?: { code?: string; message?: string } }
  const cause = e.cause?.code ?? e.cause?.message
  return cause && !e.message.includes(cause) ? `${e.message} (${cause})` : e.message
}

async function step(id: string, label: string, fn: () => Promise<string>): Promise<ConnCheck> {
  const t0 = performance.now()
  try {
    const detail = await fn()
    return { id, label, ok: true, ms: Math.round(performance.now() - t0), detail }
  } catch (err) {
    return { id, label, ok: false, ms: Math.round(performance.now() - t0), detail: msg(err) }
  }
}

async function dnsStep(host: string): Promise<ConnCheck> {
  return step(`dns-${host}`, `DNS ${host}`, async () => {
    const r = await resolveHost(host, true)
    const ips = r.addresses.slice(0, 3).map((a) => a.address).join(', ')
    if (r.via === 'system') throw new Error(`Cloudflare gagal, pakai DNS sistem → ${ips}`)
    return `${ips} (via ${r.via})`
  })
}

function wsStep(): Promise<ConnCheck> {
  return step('ws', 'WebSocket kline (fstream)', () => {
    return new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${MARKET_WS}?streams=btcusdt@kline_1m`)
      const timer = setTimeout(() => done(new Error('tidak ada data kline dalam 10 detik')), 10_000)
      let opened = false
      const done = (err: Error | null, detail = ''): void => {
        clearTimeout(timer)
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        if (err) reject(err)
        else resolve(detail)
      }
      ws.onopen = () => {
        opened = true
      }
      ws.onmessage = (m) => {
        try {
          const d = JSON.parse(String(m.data)) as { data?: { e?: string; k?: { c?: string } } }
          if (d.data?.e === 'kline') done(null, `tersambung, BTCUSDT ${d.data.k?.c ?? '?'}`)
        } catch {
          /* ignore non-json */
        }
      }
      ws.onerror = (e) => {
        const m = (e as Event & { message?: string; error?: Error }).error?.message ?? (e as Event & { message?: string }).message
        done(new Error(`gagal connect${m ? `: ${m}` : ''}`))
      }
      ws.onclose = (e) => done(new Error(`${opened ? 'ditutup' : 'gagal connect'} (code ${e.code})`))
    })
  })
}

/**
 * Bot page "Test koneksi": DNS via Cloudflare → public REST → WebSocket → signed account (if keys).
 * Read-only: never places or cancels orders.
 */
export async function testBinanceConnection(keys: { key: string; secret: string } | null): Promise<ConnTestResult> {
  const checks: ConnCheck[] = []
  checks.push(await dnsStep('fapi.binance.com'))
  checks.push(await dnsStep('fstream.binance.com'))

  let restOk = false
  checks.push(
    await step('rest', 'REST publik /fapi/v1/time', async () => {
      const t0 = Date.now()
      const res = await fetch(`${FAPI_BASE}/fapi/v1/time`, { signal: AbortSignal.timeout(10_000) })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
      const { serverTime } = JSON.parse(text) as { serverTime: number }
      const offset = serverTime - Math.round((t0 + Date.now()) / 2)
      restOk = true
      return `OK, selisih jam PC vs Binance ${offset > 0 ? '+' : ''}${offset} ms`
    })
  )
  checks.push(await wsStep())

  const sk = (id: string, label: string, detail: string): ConnCheck => ({ id, label, ok: null, ms: null, detail })
  if (!keys) {
    checks.push(sk('account', 'Akun (API key)', 'dilewati: Binance API key/secret belum diisi di Settings'))
  } else if (!restOk) {
    checks.push(sk('account', 'Akun (API key)', 'dilewati: REST publik gagal'))
  } else {
    const c = new BinanceTradeClient(keys.key, keys.secret)
    checks.push(
      await step('account', 'Akun (API key)', async () => {
        await c.syncTime()
        try {
          const eq = await c.equity()
          return `OK, equity ${eq.toFixed(2)} USDT`
        } catch (err) {
          if (err instanceof BinanceApiError && (err.code === -2015 || err.code === -2014)) {
            throw new Error(`${err.message}. Cek key, izin Futures, dan whitelist IP`)
          }
          throw err
        }
      })
    )
    if (checks.at(-1)?.ok) {
      checks.push(
        await step('mode', 'Position mode', async () => {
          if (await c.isHedgeMode()) throw new Error('Hedge Mode aktif, bot butuh One-way Mode')
          if (await c.isMultiAssets()) throw new Error('Multi-Assets Mode aktif, bot butuh Single-Asset Mode (isolated margin)')
          return 'One-way · Single-Asset'
        })
      )
    }
  }
  return { at: Date.now(), checks }
}
