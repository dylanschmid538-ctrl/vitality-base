/**
 * Tile data persistence, over HTTP.
 *
 * This module used to hand out a browser Supabase client built from the public
 * anon key. That key was the security hole: it shipped in the JS bundle, and
 * anyone who could load the page could read, rewrite and delete every row. It
 * is gone. tileStore now calls these three functions, which reach
 * /api/store/<tile_id>; only the server touches the database.
 *
 * All three are best-effort by contract — a null / false answer means "no
 * remote copy", and tileStore falls back to localStorage. That keeps a
 * Supabase-less clone, an offline phone and a logged-out session on the same
 * code path.
 */

/** Whether a remote store might exist. False once the server says it is unconfigured. */
let remoteLive = true

async function call<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!remoteLive) return null
  try {
    const res = await fetch(path, { cache: 'no-store', ...init })
    if (!res.ok) return null
    const json = (await res.json()) as T & { configured?: boolean }
    if (json.configured === false) remoteLive = false
    return json
  } catch {
    return null
  }
}

/** Read a tile's stored data. Null means "nothing remote" — caller falls back to local. */
export async function remoteLoad(tileId: string): Promise<unknown | null> {
  const r = await call<{ data: unknown }>(`/api/store/${encodeURIComponent(tileId)}`)
  return r?.data ?? null
}

/** Persist a tile's data remotely. False means the caller must rely on localStorage. */
export async function remoteSave(tileId: string, data: unknown): Promise<boolean> {
  const r = await call<{ ok: boolean }>(`/api/store/${encodeURIComponent(tileId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  return r?.ok ?? false
}

/** Delete a tile's stored data. Best-effort; local clearing happens regardless. */
export async function remoteClear(tileId: string): Promise<void> {
  await call(`/api/store/${encodeURIComponent(tileId)}`, { method: 'DELETE' })
}
