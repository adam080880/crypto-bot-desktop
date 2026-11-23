import { useState } from 'react'
import { POI_LABEL } from '@shared/smc'
import type { LiqPool, PoiStory, StoryFact, StoryResult } from '@shared/story'
import { cn } from '@/lib/utils'

const px = (n: number): string => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5))
const KIND: Record<LiqPool['kind'], string> = { swing: '', equal: ' equal', pdh: ' high kemarin', pdl: ' low kemarin', pwh: ' high minggu lalu', pwl: ' low minggu lalu' }
const poolText = (p: LiqPool): string => (p.kind === 'swing' || p.kind === 'equal' ? `${p.tf}${KIND[p.kind]}` : KIND[p.kind].trim())
const GROUP: Record<StoryFact['kind'], string> = { cause: 'Kenapa terbentuk', push: 'Dorongan', fuel: 'Bahan bakar', context: 'Konteks', draw: 'Liquidity A → B' }

/**
 * POI anatomy + liquidity draw (docs/smc-rules.md §12): for the POIs nearest to price, why each formed and what speaks
 * for / against it, plus the strongest resting liquidity above and below. Information only, not a trade signal.
 */
export function PoiStories({ data }: { data: StoryResult | null }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!data) return null
  return (
    <div className="max-h-[40vh] overflow-y-auto rounded-xl border">
      <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2 text-xs">
        <span className="font-semibold">Cerita POI</span>
        <span className="text-muted-foreground">kenapa terbentuk, ke mana harga ditarik · info, bukan sinyal</span>
      </div>
      <div className="grid gap-x-6 gap-y-1 border-b px-3 py-2 text-xs sm:grid-cols-2">
        <PoolRow title="BSL di atas (tarikan terkuat)" pools={data.pools.buy} price={data.price} />
        <PoolRow title="SSL di bawah (tarikan terkuat)" pools={data.pools.sell} price={data.price} />
      </div>
      {data.stories.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">Belum ada POI aktif ≥ 1h di dekat harga.</div>
      ) : (
        <div className="divide-y divide-border/50">
          {data.stories.map((s) => (
            <StoryRow key={s.id} s={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function PoolRow({ title, pools, price }: { title: string; pools: LiqPool[]; price: number }) {
  return (
    <div>
      <div className="text-muted-foreground">{title}</div>
      {pools.length === 0 ? (
        <div className="text-muted-foreground">tidak ada</div>
      ) : (
        <div className="num flex flex-wrap gap-x-3">
          {pools.map((p) => (
            <span key={`${p.side}${p.price}`} title={`bobot ${p.weight.toFixed(1)} · umur ${Math.round(p.ageH)} jam`}>
              {px(p.price)} <span className="text-muted-foreground">({poolText(p)}, {(((p.price - price) / price) * 100).toFixed(1)}%)</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function StoryRow({ s, open, onToggle }: { s: PoiStory; open: boolean; onToggle: () => void }) {
  const long = s.direction === 'bullish'
  const groups = (Object.keys(GROUP) as StoryFact['kind'][]).map((k) => [k, s.facts.filter((f) => f.kind === k)] as const).filter(([, f]) => f.length)
  return (
    <div className="px-3 py-1.5 text-xs">
      <button type="button" onClick={onToggle} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left">
        <span className={cn('font-semibold', long ? 'text-bull' : 'text-bear')}>{long ? 'LONG' : 'SHORT'}</span>
        <span>
          {POI_LABEL[s.kind]} {s.timeframe}
        </span>
        <span className="num">@ {px(s.level)}</span>
        <span className="num text-muted-foreground">{Math.abs(s.distPct).toFixed(2)}% dari harga</span>
        {s.target && <span className="num text-muted-foreground">B {s.target.distR.toFixed(1)}R</span>}
        <span className="num ml-auto">
          <span className="text-bull">+{s.plus}</span> / <span className="text-bear">−{s.minus}</span>
        </span>
        <span className="text-muted-foreground">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="mt-1.5 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {groups.map(([k, facts]) => (
            <div key={k}>
              <div className="text-muted-foreground">{GROUP[k]}</div>
              <ul>
                {facts.map((f, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className={cn('w-3 shrink-0 text-center', f.sign > 0 ? 'text-bull' : f.sign < 0 ? 'text-bear' : 'text-muted-foreground')}>
                      {f.sign > 0 ? '✓' : f.sign < 0 ? '✗' : '•'}
                    </span>
                    <span>{f.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
