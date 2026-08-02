import { SESSION_COOKIE, SESSION_MAX_AGE, sessionToken, safeEqual } from '@/lib/server/session'
import { checkGate, recordFailure, clearFailures } from '@/lib/server/loginGuard'

/**
 * Exchange the PIN for a session cookie. Excluded from the middleware matcher —
 * it has to be reachable without a session, by definition.
 *
 * The lockout in loginGuard is what makes a six-digit PIN defensible here; see
 * that file for why the counter is global and capped.
 *
 * The cookie is HttpOnly (JavaScript, including a compromised tile, can never
 * read it), SameSite=Lax (no cross-site request rides on it) and Secure in
 * production (never sent over plain HTTP). Locally Secure is off, otherwise
 * http://localhost could never log in.
 */

export async function POST(req: Request): Promise<Response> {
  const password = process.env.SITE_PASSWORD
  if (!password) return Response.json({ error: 'gate_disabled' }, { status: 400 })

  // The lockout is checked BEFORE the PIN, so a locked door cannot be used as
  // an oracle that answers "was that digit right?" while it is supposed to be shut.
  const gate = await checkGate()
  if (gate.locked) {
    return Response.json({ error: 'locked', retryAfter: gate.retryAfter }, { status: 429 })
  }

  let body: { password?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 })
  }

  const given = typeof body.password === 'string' ? body.password : ''

  /*
   * Compare the DERIVED tokens, not the raw strings: both sides are then the
   * same fixed length, so the comparison cannot leak the PIN's length.
   */
  const ok = safeEqual(await sessionToken(given), await sessionToken(password))
  if (!ok) {
    const now = await recordFailure()
    return Response.json(
      { error: now.locked ? 'locked' : 'wrong_password', retryAfter: now.retryAfter },
      { status: now.locked ? 429 : 401 },
    )
  }

  await clearFailures()

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie':
        `${SESSION_COOKIE}=${await sessionToken(password)}` +
        `; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
    },
  })
}
