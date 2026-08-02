import { db, dbConfigured } from '@/lib/server/db'

/**
 * The `tiles` table — the sealed HTML of tiles built from Claude (the MCP
 * connector) or pasted in through "+ New tile". Same deal as [slot]/route.ts:
 * the browser used to reach Supabase directly and now goes through here, gated
 * by middleware.ts.
 *
 * Note this route sits at /api/store/tiles while tile DATA sits at
 * /api/store/<slot>. 'tiles' is not a slot id (see SLOTS in the sibling route),
 * so the two can never collide.
 */

export async function GET(): Promise<Response> {
  const c = db()
  if (!c) return Response.json({ configured: false, tiles: {} })

  const { data, error } = await c.from('tiles').select('slot, html, name')
  if (error || !data) return Response.json({ configured: true, tiles: {} })

  const tiles: Record<string, { html: string; name: string | null }> = {}
  for (const row of data as Array<{ slot: string; html: string; name: string | null }>) {
    if (row.slot && typeof row.html === 'string' && row.html.trim()) {
      tiles[row.slot] = { html: row.html, name: row.name ?? null }
    }
  }
  return Response.json({ configured: true, tiles })
}

/** A pasted tile can be large; cap it here too so one request can't bloat the table. */
const MAX_TILE_HTML = 1024 * 1024

export async function POST(req: Request): Promise<Response> {
  if (!dbConfigured()) return Response.json({ configured: false, ok: false })

  let body: { slot?: unknown; html?: unknown; name?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 })
  }

  const slot = typeof body.slot === 'string' ? body.slot.trim() : ''
  const html = typeof body.html === 'string' ? body.html : ''
  if (!slot || !html.trim()) return Response.json({ error: 'missing_slot_or_html' }, { status: 400 })
  if (html.length > MAX_TILE_HTML) return Response.json({ error: 'too_large' }, { status: 413 })

  const { error } = await db()!.from('tiles').upsert(
    {
      slot,
      html,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'slot' },
  )
  return Response.json({ configured: true, ok: !error, error: error?.message })
}

/**
 * The dashboard's Reset button: wipe every tile's data AND every built tile.
 * Destructive and unrecoverable, so it needs an explicit `{ confirm: 'wipe' }`
 * body — a bare DELETE arriving by accident (a stray fetch, a prefetch, a
 * retried request) must never be enough to erase the board.
 */
export async function DELETE(req: Request): Promise<Response> {
  if (!dbConfigured()) return Response.json({ configured: false, ok: false })

  let body: { confirm?: unknown } = {}
  try {
    body = await req.json()
  } catch {
    /* no body — falls through to the guard below */
  }
  if (body.confirm !== 'wipe') return Response.json({ error: 'confirm_required' }, { status: 400 })

  const c = db()!
  // PostgREST refuses an unfiltered delete, so match every real row.
  const a = await c.from('tile_data').delete().neq('tile_id', '')
  const b = await c.from('tiles').delete().neq('slot', '')
  return Response.json({ configured: true, ok: !a.error && !b.error })
}
