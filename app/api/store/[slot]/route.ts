import { db, dbConfigured } from '@/lib/server/db'

/**
 * A tile's saved data — the server-side replacement for the browser talking to
 * Supabase itself. The client (lib/sync.ts, lib/tiles/tileStore.ts) calls these
 * three verbs; only this file knows a database exists.
 *
 * Auth is NOT here on purpose: middleware.ts gates every /api/store request
 * before it arrives, so one guard covers every route instead of each one
 * re-implementing it. Anything that skips the middleware matcher is unprotected
 * by definition, so the matcher is the thing to read carefully, not this file.
 *
 * `configured: false` (never a 500) is how "the owner never set up Supabase"
 * reaches the client, because a base with no backend is a supported state.
 */

/** Slot ids that may be addressed. Anything else would let a caller mint rows at will. */
const SLOTS = ['train', 'fuel', 'vitals', 'vee', 'brand', 'peak', 'finance']

/** tileStore writes `me:<slot>`, sync.ts writes the bare slot — both are legal here. */
function validSlot(raw: string): string | null {
  const slot = decodeURIComponent(raw)
  const bare = slot.startsWith('me:') ? slot.slice(3) : slot
  return SLOTS.includes(bare) ? slot : null
}

type Ctx = { params: { slot: string } }

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const slot = validSlot(ctx.params.slot)
  if (!slot) return Response.json({ error: 'bad_slot' }, { status: 400 })
  const c = db()
  if (!c) return Response.json({ configured: false, data: null })

  const { data, error } = await c.from('tile_data').select('data').eq('tile_id', slot).maybeSingle()
  if (error) return Response.json({ configured: true, data: null, error: error.message })
  return Response.json({ configured: true, data: data?.data ?? null })
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const slot = validSlot(ctx.params.slot)
  if (!slot) return Response.json({ error: 'bad_slot' }, { status: 400 })
  if (!dbConfigured()) return Response.json({ configured: false, ok: false })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || !('data' in body)) {
    return Response.json({ error: 'missing_data' }, { status: 400 })
  }

  const { error } = await db()!
    .from('tile_data')
    .upsert(
      { tile_id: slot, data: (body as { data: unknown }).data, updated_at: new Date().toISOString() },
      { onConflict: 'tile_id' },
    )
  return Response.json({ configured: true, ok: !error, error: error?.message })
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const slot = validSlot(ctx.params.slot)
  if (!slot) return Response.json({ error: 'bad_slot' }, { status: 400 })
  if (!dbConfigured()) return Response.json({ configured: false, ok: false })

  const { error } = await db()!.from('tile_data').delete().eq('tile_id', slot)
  return Response.json({ configured: true, ok: !error, error: error?.message })
}
