import { db, dbConfigured } from '@/lib/server/db'

/**
 * The door Apple Health knocks on.
 *
 * HealthKit has no cloud API — the data is encrypted on the phone and Apple
 * deliberately lets nobody query it from outside. So the pull does not exist;
 * the phone has to push. An Apple Shortcut (Kurzbefehle) reads the day's
 * samples and POSTs them here on a schedule. No App Store app, no developer
 * account, no third-party service holding the user's health data.
 *
 * Nutrition rides the same wire: Yazio writes calories and macros into Apple
 * Health, so the Shortcut picks them up with everything else and this route
 * never has to know Yazio exists.
 *
 * AUTH is a bearer token of its own (HEALTH_TOKEN), NOT the session cookie and
 * NOT MCP_TOKEN. A token that lives inside a Shortcut on a phone is the most
 * exposed credential in this project — it should be able to do exactly one
 * thing. This one writes health numbers and nothing else.
 *
 * Therefore this route is excluded from the password gate in middleware.ts,
 * the same way /api/mcp is: it carries its own auth.
 */

/** One day's numbers. Every field optional — a phone that logged nothing sends nothing. */
interface Payload {
  date?: string
  sleepHours?: number
  weightKg?: number
  kcal?: number
  protein?: number
  carbs?: number
  fat?: number
  water?: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Accept a number only when it is finite and in a range a human body produces. */
function num(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && isFinite(v) && v >= 0 && v <= max ? Math.round(v * 100) / 100 : undefined
}

/**
 * Read a slot, apply `patch` to the decoded object, write it back under BOTH
 * keys. Two keys because lib/sync.ts writes the bare slot and tileStore writes
 * `me:<slot>`, and whichever is read first wins — updating one would leave the
 * dashboard showing whichever copy it happened to load.
 *
 * ponytail: read-modify-write with no locking. Two writers racing here would
 * need the Shortcut and a manual save in the same second; if that ever
 * actually collides, the fix is a Postgres jsonb merge, not a lock.
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

  // The Shortcut sends the day it read. Fall back to today rather than
  // rejecting, so a malformed date never silently drops a night's sleep.
  const date = typeof body.date === 'string' && DATE_RE.test(body.date)
    ? body.date
    : new Date().toISOString().slice(0, 10)

  const sleepHours = num(body.sleepHours, 24)
  const weightKg = num(body.weightKg, 400)
  const kcal = num(body.kcal, 20000)
  const protein = num(body.protein, 1000)
  const carbs = num(body.carbs, 2000)
  const fat = num(body.fat, 1000)
  const water = num(body.water, 50)

  const wrote: string[] = []

  if (sleepHours != null || weightKg != null) {
    await mergeSlot('vitals', (d) => {
      const day = (d[date] && typeof d[date] === 'object' ? d[date] : {}) as Record<string, unknown>
      if (sleepHours != null) day.sleepHours = sleepHours
      if (weightKg != null) day.weightKg = weightKg
      d[date] = day
    })
    wrote.push('vitals')
  }

  const hasNutrition = kcal != null || protein != null || carbs != null || fat != null
  if (hasNutrition || water != null) {
    await mergeSlot('fuel', (d) => {
      if (hasNutrition) {
        const n = (d.nutrition && typeof d.nutrition === 'object' ? d.nutrition : {}) as Record<string, unknown>
        const day = (n[date] && typeof n[date] === 'object' ? n[date] : {}) as Record<string, unknown>
        if (kcal != null) day.kcal = kcal
        if (protein != null) day.protein = protein
        if (carbs != null) day.carbs = carbs
        if (fat != null) day.fat = fat
        n[date] = day
        d.nutrition = n
      }
      if (water != null) {
        const w = (d.water && typeof d.water === 'object' ? d.water : {}) as Record<string, unknown>
        w[date] = water
        d.water = w
      }
    })
    wrote.push('fuel')
  }

  // An empty push is not an error — the Shortcut ran on a day with no data.
  // Say so plainly so the phone's run log shows why nothing changed.
  return Response.json({ ok: true, date, wrote, empty: wrote.length === 0 })
}
