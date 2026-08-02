import { db } from './db'

/**
 * Failed-attempt lockout — the thing that makes a 6-digit PIN safe.
 *
 * A six-digit code is a million combinations. Against an endpoint that answers
 * instantly and forever, that is minutes of parallel guessing, which would undo
 * the entire point of moving the database behind the server. An iPhone passcode
 * is the same six digits and is fine, for exactly one reason: the phone stops
 * answering after a few wrong tries. This does the same.
 *
 * State lives in Supabase, not in memory, because serverless has neither a
 * stable process nor a single instance: an in-memory counter resets on every
 * cold start and does not exist across parallel lambdas, so an attacker just
 * keeps landing on fresh ones. A row is the only thing every instance shares.
 *
 * ponytail: ONE global counter, not per-IP. Per-IP is the textbook answer and
 * it is the wrong one here — an attacker rotating IPs walks straight past it,
 * while a single-user board has nobody to be fair to. The cost is that someone
 * hammering the endpoint can lock the owner out, which is why the delay is
 * CAPPED at 15 minutes rather than escalating forever. If that DoS ever
 * actually happens, per-IP buckets on top are the upgrade.
 */

const ROW = 'login'

/** Wrong tries allowed before the door closes at all. */
const FREE_TRIES = 5

/**
 * How long the door stays shut, by how many failures have piled up. Capped on
 * purpose — see the ponytail note above.
 */
function lockSeconds(fails: number): number {
  if (fails < FREE_TRIES) return 0
  if (fails < 10) return 60
  if (fails < 15) return 5 * 60
  return 15 * 60
}

export interface GateState {
  locked: boolean
  /** Seconds until the next attempt is allowed. 0 when open. */
  retryAfter: number
}

/**
 * Is the door currently shut? Fails OPEN when Supabase is unreachable: a
 * database outage must not brick the owner out of their own board, and the PIN
 * check itself still has to pass.
 */
export async function checkGate(): Promise<GateState> {
  const c = db()
  if (!c) return { locked: false, retryAfter: 0 }

  const { data, error } = await c
    .from('auth_attempts')
    .select('fails, locked_until')
    .eq('id', ROW)
    .maybeSingle()
  if (error || !data) return { locked: false, retryAfter: 0 }

  const until = data.locked_until ? Date.parse(data.locked_until as string) : 0
  const left = Math.ceil((until - Date.now()) / 1000)
  return left > 0 ? { locked: true, retryAfter: left } : { locked: false, retryAfter: 0 }
}

/** Record a wrong PIN and arm the next lockout. Returns the state that now applies. */
export async function recordFailure(): Promise<GateState> {
  const c = db()
  if (!c) return { locked: false, retryAfter: 0 }

  const { data } = await c.from('auth_attempts').select('fails').eq('id', ROW).maybeSingle()
  const fails = ((data?.fails as number) ?? 0) + 1
  const secs = lockSeconds(fails)
  const lockedUntil = secs ? new Date(Date.now() + secs * 1000).toISOString() : null

  await c
    .from('auth_attempts')
    .upsert({ id: ROW, fails, locked_until: lockedUntil, updated_at: new Date().toISOString() })
  return { locked: secs > 0, retryAfter: secs }
}

/** A correct PIN wipes the slate, so ordinary fat-finger days never accumulate. */
export async function clearFailures(): Promise<void> {
  const c = db()
  if (!c) return
  await c
    .from('auth_attempts')
    .upsert({ id: ROW, fails: 0, locked_until: null, updated_at: new Date().toISOString() })
}
