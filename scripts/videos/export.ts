/**
 * Exports the data for the README case-study videos (read-only DB): real candles around a closed bot trade, the POI story
 * of its parent POI at the moment the setup became known (no look-ahead), and the bot's own events for that trade.
 * Bundle with esbuild (see scripts/videos/README.md) and run with ELECTRON_RUN_AS_NODE=1 electron.
 */
import { writeFileSync } from 'fs'
import { openDatabase } from '../../src/main/db/client'
import { readSetting } from '../../src/main/db/settingsRepo'
import { appConfigSchema, defaultAppConfig } from '@shared/config'
import { SmcService } from '../../src/main/strategy/service'
import { collectAllPois, detectSetups } from '../../src/main/strategy/setups'
import { liquidityPools, poiStory } from '../../src/main/strategy/story'
import { InducementIndex } from '../../src/main/strategy/inducement'
import { TF_MS } from '@shared/timeframes'

const [, , DB, OUT, ...IDS] = process.argv as string[]
const db = openDatabase({ path: DB!, migrationsFolder: 'drizzle', readonly: true })
const app = readSetting(db, 'app_config', appConfigSchema) ?? defaultAppConfig
const smc = new SmcService(db)
const out: unknown[] = []
for (const id of IDS) {
  const row = db.$client.prepare('SELECT symbol, payload FROM bot_trades WHERE id = ?').get(id) as { symbol: string; payload: string } | undefined
  if (!row) continue
  const t = JSON.parse(row.payload)
  const cfg = { ...app.smc, models: [t.model] }
  const h = smc.history(row.symbol, cfg)!
  const all = [h.entry, ...h.poiAnalyses.filter((a) => a.timeframe !== h.entry.timeframe)]
  const setups = detectSetups({ symbol: row.symbol, entry: h.entry, poiAnalyses: h.poiAnalyses, cfg, exit: app.exit, btc: h.btc, smtRef: h.smtRef })
  // the setup the bot traded: same id, and the parent POI the bot recorded (kind + timeframe)
  const same = (x: (typeof setups)[number]): boolean => x.poi.kind === t.poi.kind && x.poi.timeframe === t.poi.timeframe
  const s =
    setups.find((x) => x.id === t.setupId && same(x)) ??
    setups.find((x) => x.createdT === setups.find((y) => y.id === t.setupId)?.createdT && x.direction === t.direction && same(x)) ??
    setups.find((x) => x.id === t.setupId)
  if (!s) {
    console.error('setup not found', t.setupId)
    continue
  }
  const known = s.createdT + TF_MS['15m']
  const pois = collectAllPois(all, cfg)
  const parent = pois.find((p) => p.kind === s.poi.kind && p.timeframe === s.poi.timeframe && p.t === s.poi.t && p.direction === s.direction)
  const pools = liquidityPools(all, known)
  const active = pois.filter((p) => p.activeFrom <= known && (p.invalidT === null || p.invalidT + TF_MS[p.timeframe] > known))
  const idx = new InducementIndex(h.entry, all, pois, { baitDays: cfg.baitDays, windowAtr: cfg.idmWindowAtr })
  const story = parent
    ? poiStory(parent, all, { at: known, price: s.entry, pois: active, allPois: pois, originNearPct: cfg.originNearPct, pools, btc4h: h.btc?.['4h'], idx, pdTimeframe: cfg.pdTimeframe, pdLookback: cfg.pdLookback })
    : null
  const from = known - 24 * 3600_000
  const to = (t.closedAt ?? known) + 6 * 3600_000
  const candles = h.entry.candles.filter((c) => c.t >= from && c.t <= to).map((c) => [c.t, c.o, c.h, c.l, c.c])
  const events = db.$client
    .prepare('SELECT t, level, message FROM bot_events WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t')
    .all(row.symbol, t.createdAt - 60_000, (t.closedAt ?? known) + 60_000) as { t: number; level: string; message: string }[]
  out.push({
    id,
    symbol: row.symbol,
    model: t.model,
    direction: t.direction,
    entry: t.entry,
    sl: t.slInitial ?? t.sl,
    tp: t.tp,
    createdAt: t.createdAt,
    filledAt: t.filledAt,
    closedAt: t.closedAt,
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    known,
    poi: parent ? { kind: parent.kind, tf: parent.timeframe, level: parent.level, extreme: parent.extreme ?? null, originT: parent.originT ?? null, activeFrom: parent.activeFrom } : null,
    child: s.child,
    story,
    pools: pools.filter((p) => Math.abs(p.price / s.entry - 1) < 0.06).sort((a, b) => b.weight - a.weight).slice(0, 6),
    candles,
    events: events.filter((e) => e.level !== 'skip').map((e) => ({ t: e.t, msg: e.message }))
  })
  console.error('ok', row.symbol, candles.length, 'candles', events.length, 'events', story ? story.facts.length + ' facts' : 'no story')
}
writeFileSync(OUT!, JSON.stringify(out))
