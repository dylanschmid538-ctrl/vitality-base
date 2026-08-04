import { db, dbConfigured } from '@/lib/server/db'
import { METRICS, clean } from '@/lib/server/healthMetrics'

/**
 * The door Apple Health knocks on.
 *
 * HealthKit has no cloud API — the data is encrypted on the phone and Apple
 * deliberately lets nobody query it from outside. So the pull does not exist;
 * the phone has to push. The companion iOS app watches HealthKit and POSTs
 * here whenever new samples land.
 *
 * Fitbit and Yazio both write into Apple Health, so neither needs its own
 * integration: they arrive here as ordinary metrics and this route never has
 * to know they exist.
 *
 * The payload is an OPEN metric map, not a fixed set of fields. Which keys are
 * legal, where they land and what counts as a sane value all live in
 * lib/server/healthMetrics.ts — so a new metric is a server deploy, never a
 * new build of the app.
 *
 * AUTH is a bearer of its own (HEALTH_TOKEN), NOT the session cookie and NOT
 * MCP_TOKEN. A token sitting inside an app on a phone is the most exposed
 * credential in this project, so it can do exactly one thing: write health
 * numbers. Hence the exclusion from the password gate in middleware.ts.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** One day. `metrics` keys are the names from /api/health/config. */
interface Payload {
  date?: string
  metrics?: Record<string, unknown>
}

/**
 * Read a slot, apply `patch`, write it back under BOTH keys. Two keys because
 * lib/sync.ts writes the bare slot and tileStore writes `me:<slot>`, and
 * whichever is read first wins — updating one would leave the dashboard
 * showing whichever copy it happened to load.
 *
 * ponytail: read-modify-write, no locking. Two writers would have to collide
 * inside the same second; if that ever actually happens, the fix is a Postgres
 * jsonb merge, not a lock.
 */
async function mergeSlot(slot: string, patch: (data: Record<string, unknown>) => void): Promise<void> {
  const c = db()!
  for (const key of [slot, `me:${slot}`]) {
    const { data } = await c.from('tile_data').select('data').eq('tile_id', key).maybeSingle()
    const current = (data?.data && typeof data.data === 'object' && !Array.isArray(data.data)
      ? data.data
      : {}) as Record<string, unknown>
    patch(current)
    await c
      .from('tile_data')
      .upsert({ tile_id: key, data: current, updated_at: new Date().toISOString() }, { onConflict: 'tile_id' })
  }
}

/** Walk to `data[group][date]` (or `data[date]`), creating plain objects on the way. */
function dayBucket(data: Record<string, unknown>, group: string | undefined, date: string): Record<string, unknown> {
  let parent = data
  if (group) {
    const g = data[group]
    parent = (g && typeof g === 'object' && !Array.isArray(g) ? g : {}) as Record<string, unknown>
    data[group] = parent
  }
  const d = parent[date]
  const bucket = (d && typeof d === 'object' && !Array.isArray(d) ? d : {}) as Record<string, unknown>
  parent[date] = bucket
  return bucket
}

export async function POST(req: Request): Promise<Response> {
  const token = process.env.HEALTH_TOKEN
  if (!token) return Response.json({ error: 'health_sync_disabled' }, { status: 503 })

  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (given !== token) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!dbConfigured()) return Response.json({ error: 'no_database' }, { status: 503 })

  let body: Payload
  try {
    body = (await req.json()) as Payload
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 })
  }

  // The app sends the day it read. Fall back to today rather than rejecting,
  // so a malformed date never silently drops a night's sleep.
  const date = typeof body.date === 'string' && DATE_RE.test(body.date)
    ? body.date
    : new Date().toISOString().slice(0, 10)

  const incoming = body.metrics && typeof body.metrics === 'object' ? body.metrics : {}

  // Group the accepted values by the slot they belong to, so each slot is
  // read and written ONCE no matter how many metrics arrived.
  const bySlot = new Map<string, Array<[string, string | undefined, number]>>()
  const accepted: string[] = []
  const rejected: string[] = []

  for (const [key, raw] of Object.entries(incoming)) {
    const value = clean(key, raw)
    if (value == null) {
      rejected.push(key)
      continue
    }
    const spec = METRICS[key]
    const list = bySlot.get(spec.slot) || []
    list.push([key, spec.group, value])
    bySlot.set(spec.slot, list)
    accepted.push(key)
  }

  for (const [slot, entries] of bySlot) {
    await mergeSlot(slot, (data) => {
      for (const [key, group, value] of entries) {
        dayBucket(data, group, date)[key] = value
      }
    })
  }

  // An empty push is not an error — the app ran on a day with nothing new.
  // Naming the rejected keys matters: that is how a wrong unit or a stale app
  // config shows up, instead of a metric quietly never arriving.
  return Response.json({
    ok: true,
    date,
    accepted,
    rejected,
    slots: [...bySlot.keys()],
  })
}
