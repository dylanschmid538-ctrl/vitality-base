'use client'

/**
 * Cross-device sync for tile data — now over HTTP, not Supabase.
 *
 * This module used to hold a Supabase client and the public anon key, which is
 * exactly what made every row world-readable once the site was deployed. The
 * key is gone; these functions call /api/store/*, and only the server knows a
 * database exists. Every signature here is unchanged, so useTileHost and
 * DashboardGrid did not have to move.
 *
 * "Unconfigured" is a supported state, not an error: without Supabase the base
 * stays purely local (localStorage) and every function below no-ops.
 */

/**
 * Whether the server has Supabase configured. Answered by the server on first
 * ask and cached, because the client can no longer read the env vars itself.
 * Undefined until the first call resolves — callers treat that as "not yet".
 */
let configured: boolean | undefined

/** Best-effort JSON fetch. Any failure (offline, 401, 500) reads as "no sync". */
async function call<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(path, { cache: 'no-store', ...init })
    if (!res.ok) return null
    const json = (await res.json()) as T & { configured?: boolean }
    if (typeof json.configured === 'boolean') configured = json.configured
    return json
  } catch {
    return null
  }
}

/**
 * Whether cross-device sync is on. Synchronous because its callers are render
 * paths, so it answers from the cached flag and defaults to TRUE until the
 * first response lands — an optimistic default means a slow first request shows
 * a brief empty state instead of silently skipping the cloud copy entirely.
 * The flag is set as a side effect of the first real call, so nothing has to
 * probe up front.
 */
export const syncEnabled = (): boolean => configured !== false

/** Push a tile's data. Best-effort; returns false on any failure. */
export async function syncSave(tileId: string, data: unknown): Promise<boolean> {
  const r = await call<{ ok: boolean }>(`/api/store/${encodeURIComponent(tileId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  return r?.ok ?? false
}

/** Read a tile's data, or null if unconfigured / missing / offline. */
export async function syncLoad(tileId: string): Promise<unknown | null> {
  const r = await call<{ data: unknown }>(`/api/store/${encodeURIComponent(tileId)}`)
  return r?.data ?? null
}

/** A tile document built from Claude (the MCP connector) or the paste box. */
export interface RemoteTile {
  html: string
  name: string | null
}

/** Every built tile, keyed by slot. Empty object when unconfigured or offline. */
export async function syncLoadTiles(): Promise<Record<string, RemoteTile>> {
  const r = await call<{ tiles: Record<string, RemoteTile> }>('/api/store/tiles')
  return r?.tiles ?? {}
}

/** Write a tile into the `tiles` table. False if unconfigured or the write fails. */
export async function syncSaveTile(slot: string, html: string, name?: string): Promise<boolean> {
  const r = await call<{ ok: boolean }>('/api/store/tiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot, html, name: name ?? null }),
  })
  return r?.ok ?? false
}

/** Wipe every tile's data AND every built tile. Destructive; the server demands the confirm. */
export async function syncWipe(): Promise<void> {
  await call('/api/store/tiles', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'wipe' }),
  })
}
