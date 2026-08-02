import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * The ONLY door to Supabase, and it is server-side.
 *
 * Before this module the browser held a Supabase key and talked to the database
 * directly. That key ships inside the JS bundle, so anyone who could load the
 * page could read, rewrite and delete every row — verified against the live
 * project, not assumed. Financial data is about to live in these tables, so the
 * browser lost its key entirely.
 *
 * SUPABASE_SECRET_KEY has no NEXT_PUBLIC_ prefix, so Next never inlines it into
 * client code — that alone is the security guarantee. The window check below is
 * only a legibility guard: without it, importing this from a client component
 * would quietly hand back null and look like "sync is broken" instead of naming
 * the actual mistake.
 * ponytail: a throw beats pulling in the `server-only` package for the same hint.
 *
 * The secret key bypasses RLS by design. That is safe ONLY because it never
 * leaves the server and every route that uses it sits behind the password gate
 * in middleware.ts (or, for the connector, its own bearer). See
 * supabase/lockdown.sql — after it runs, RLS has no policies at all, so this
 * key is the one and only way in.
 */

function assertServer(): void {
  if (typeof window !== 'undefined') {
    throw new Error('lib/server/db.ts is server-only — call the /api/store routes from the browser.')
  }
}

let client: SupabaseClient | null = null

/** The service client, or null when Supabase is not configured (app stays local-only). */
export function db(): SupabaseClient | null {
  assertServer()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) return null
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return client
}

/** Whether cross-device sync is configured at all. */
export const dbConfigured = (): boolean =>
  !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SECRET_KEY)
