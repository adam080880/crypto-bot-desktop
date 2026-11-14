/**
 * Resolve hostnames through Cloudflare (1.1.1.1 / 1.0.0.1) instead of the system/ISP resolver.
 * Some ISPs (e.g. in Indonesia) block Binance by poisoning DNS, so every HTTP request and
 * WebSocket in this process goes through an undici Agent with this lookup (global dispatcher;
 * Node's built-in fetch and WebSocket both use it).
 *
 * Order: DNS-over-HTTPS to 1.1.1.1 → 1.0.0.1 (port 443, survives ISPs that hijack port 53)
 * → plain DNS (UDP) to 1.1.1.1/1.0.0.1 → system resolver as last resort (logged).
 * Results are cached by TTL (clamped 30 s – 10 min). Set env SMC_SYSTEM_DNS=1 to disable.
 */
import { lookup as systemLookup, Resolver } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from 'undici'
import { logger } from '../logger'

const log = logger('dns')

export const CLOUDFLARE_DNS = ['1.1.1.1', '1.0.0.1'] as const

export type DnsVia = 'doh-1.1.1.1' | 'doh-1.0.0.1' | 'udp-cloudflare' | 'system'
export interface Resolved {
  addresses: { address: string; family: 4 | 6 }[]
  via: DnsVia
  expires: number
}

const MIN_TTL_S = 30
const MAX_TTL_S = 600
const cache = new Map<string, Resolved>()
const inflight = new Map<string, Promise<Resolved>>()

/** DoH requests go to IP literals, so they never recurse into our lookup. */
const dohAgent = new Agent({ connect: { timeout: 4000 } })

const ttlMs = (ttl: number): number => Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, ttl || MIN_TTL_S)) * 1000

async function viaDoh(server: string, host: string): Promise<Omit<Resolved, 'via'>> {
  for (const [type, code, family] of [['A', 1, 4], ['AAAA', 28, 6]] as const) {
    const res = await undiciFetch(`https://${server}/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      dispatcher: dohAgent,
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) throw new Error(`DoH ${server} HTTP ${res.status}`)
    const j = (await res.json()) as { Status: number; Answer?: { type: number; data: string; TTL: number }[] }
    if (j.Status !== 0) throw new Error(`DoH ${server} status ${j.Status}`)
    const ans = (j.Answer ?? []).filter((a) => a.type === code && isIP(a.data))
    if (ans.length) {
      return {
        addresses: ans.map((a) => ({ address: a.data, family })),
        expires: Date.now() + ttlMs(Math.min(...ans.map((a) => a.TTL)))
      }
    }
  }
  throw new Error(`DoH ${server}: no A/AAAA record for ${host}`)
}

async function viaUdp(host: string): Promise<Omit<Resolved, 'via'>> {
  const r = new Resolver({ timeout: 3000, tries: 2 })
  r.setServers([...CLOUDFLARE_DNS])
  const v4 = await r.resolve4(host, { ttl: true }).catch(() => [])
  if (v4.length) {
    return { addresses: v4.map((a) => ({ address: a.address, family: 4 as const })), expires: Date.now() + ttlMs(Math.min(...v4.map((a) => a.ttl))) }
  }
  const v6 = await r.resolve6(host, { ttl: true })
  if (!v6.length) throw new Error(`udp: no record for ${host}`)
  return { addresses: v6.map((a) => ({ address: a.address, family: 6 as const })), expires: Date.now() + ttlMs(Math.min(...v6.map((a) => a.ttl))) }
}

async function resolveFresh(host: string): Promise<Resolved> {
  const errors: string[] = []
  for (const server of CLOUDFLARE_DNS) {
    try {
      return { ...(await viaDoh(server, host)), via: `doh-${server}` as DnsVia }
    } catch (err) {
      errors.push((err as Error).message)
    }
  }
  try {
    return { ...(await viaUdp(host)), via: 'udp-cloudflare' }
  } catch (err) {
    errors.push((err as Error).message)
  }
  log.warn({ host, errors }, 'Cloudflare DNS failed, falling back to system resolver')
  const sys = await systemLookup(host, { all: true })
  return {
    addresses: sys.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })),
    via: 'system',
    expires: Date.now() + MIN_TTL_S * 1000
  }
}

/** Resolve via Cloudflare (cached). `fresh` skips the cache (used by the connection test). */
export async function resolveHost(host: string, fresh = false): Promise<Resolved> {
  const key = host.toLowerCase()
  const hit = cache.get(key)
  if (!fresh && hit && hit.expires > Date.now()) return hit
  let p = inflight.get(key)
  if (!p) {
    p = resolveFresh(key).finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  const r = await p
  cache.set(key, r)
  return r
}

/** `net`/`tls` compatible lookup (handles both `all: true` and single-address callers). */
export const cloudflareLookup: LookupFunction = (hostname, options, callback) => {
  const family = typeof options === 'number' ? options : options?.family
  const all = typeof options === 'object' && !!options?.all
  if (isIP(hostname)) {
    const f = isIP(hostname) as 4 | 6
    return all ? callback(null, [{ address: hostname, family: f }]) : callback(null, hostname, f)
  }
  resolveHost(hostname).then(
    (r) => {
      let list = r.addresses
      const want = family === 4 || family === 'IPv4' ? 4 : family === 6 || family === 'IPv6' ? 6 : 0
      if (want) list = list.filter((a) => a.family === want)
      if (!list.length) {
        const e = Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname })
        return callback(e, '', 4)
      }
      if (all) return callback(null, list)
      const first = list[0]!
      callback(null, first.address, first.family)
    },
    (err: Error) => callback(Object.assign(err, { code: (err as NodeJS.ErrnoException).code ?? 'ENOTFOUND' }), '', 4)
  )
}

let installed = false

/** Route all fetch/WebSocket traffic of this process through Cloudflare DNS. Idempotent. */
export function installCloudflareDns(): void {
  if (installed) return
  installed = true
  if (process.env.SMC_SYSTEM_DNS === '1') {
    log.info('SMC_SYSTEM_DNS=1: using system DNS')
    return
  }
  setGlobalDispatcher(new Agent({ connect: { lookup: cloudflareLookup } }))
  log.info({ servers: CLOUDFLARE_DNS }, 'DNS via Cloudflare (DoH, fallback UDP)')
}
