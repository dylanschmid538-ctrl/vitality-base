/**
 * The password gate's one shared truth: what a valid session cookie looks like.
 *
 * Deliberately not a JWT and not a library. The deployment is one person on
 * their own board, so a session needs to answer exactly one question — "did
 * this browser present the password?" — and a keyed hash answers it.
 *
 * The cookie holds HMAC-SHA256(SITE_PASSWORD, "vitality-session-v1"). The
 * password itself is never in the cookie, and the value cannot be forged
 * without it. Rotating SITE_PASSWORD invalidates every existing cookie, which
 * is the behaviour you want from a password change.
 *
 * Web Crypto (not node:crypto) because middleware runs on the Edge runtime.
 *
 * ponytail: no expiry beyond the cookie's own Max-Age, no revocation list, no
 * refresh. If this ever grows past one user, that is the moment for real auth
 * (Supabase Auth, RLS on auth.uid()) — not the moment to bolt sessions onto
 * this.
 */

export const SESSION_COOKIE = 'vitality_session'

/** 30 days: long enough that the phone PWA is not a login prompt every morning. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30

const encoder = new TextEncoder()

/** The expected cookie value for the configured password. */
export async function sessionToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode('vitality-session-v1'))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Compare without leaking WHERE two values differ through timing. Length is
 * compared first and non-secretly: both sides are fixed-length hex here, so an
 * early length exit reveals nothing an attacker does not already know.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Does this cookie value prove the password was presented? */
export async function validSession(cookie: string | undefined, password: string | undefined): Promise<boolean> {
  if (!cookie || !password) return false
  return safeEqual(cookie, await sessionToken(password))
}
