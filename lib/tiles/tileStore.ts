import type { Tile, TileData, TileEnvelope, ReportKind } from './types'
import { tileSkin, type Skin } from './tileSkin'
import { remoteLoad, remoteSave, remoteClear } from './tileSupabase'

/**
 * tileStore is the ONLY module that touches persistence for user tiles.
 *
 * v1 is localStorage, scoped per user. Swapping this one module to Supabase
 * later never touches a tile or the host. Every key is namespaced by userId so
 * one user can never read another's tiles (multi-user from the ground up).
 * Note: localStorage has no cross-user isolation on a shared device, so v1 is
 * single-device. The Supabase swap adds RLS:
 *   tiles(id, user_id, name, html, created_at, updated_at)
 *   tile_data(tile_id, user_id, data jsonb)
 *
 * Keys:
 *   vitality:<userId>:tiles            -> Tile[]  (the index, source order)
 *   vitality:<userId>:tile:<id>:data   -> whatever Vitality.save() persisted
 */

const indexKey = (userId: string) => `vitality:${userId}:tiles`
const dataKey = (userId: string, id: string) => `vitality:${userId}:tile:${id}:data`
const legacyKey = (userId: string) => `vitality:${userId}:tile:draft` // BUILD71 single key

const hasStorage = () => typeof window !== 'undefined' && !!window.localStorage

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'tile-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function readIndex(userId: string): Tile[] {
  if (!hasStorage()) return []
  try {
    const raw = window.localStorage.getItem(indexKey(userId))
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writeIndex(userId: string, list: Tile[]) {
  if (!hasStorage()) return
  try {
    window.localStorage.setItem(indexKey(userId), JSON.stringify(list))
  } catch {
    /* quota / blocked. fail quiet, the session still works */
  }
}

function listTiles(userId: string): Tile[] {
  return readIndex(userId).sort((a, b) => b.createdAt - a.createdAt) // newest first
}

function getTile(userId: string, id: string): Tile | undefined {
  return readIndex(userId).find((t) => t.id === id)
}

function createTile(
  userId: string,
  input: {
    name: string
    html: string
    category?: string
    // the tile's declared stream (report contract), so share/publish
    // round-trips keep it (PATCH21)
    key?: string
    label?: string
    kind?: ReportKind
    goalDirection?: 'up' | 'down'
  },
): Tile {
  const now = Date.now()
  const tile: Tile = {
    id: uuid(),
    name: input.name.trim() || 'Untitled tile',
    html: input.html,
    createdAt: now,
    updatedAt: now,
  }
  if (input.category) tile.category = input.category
  if (input.key) tile.key = input.key
  if (input.label) tile.label = input.label
  if (input.kind) tile.kind = input.kind
  if (input.goalDirection) tile.goalDirection = input.goalDirection
  const list = readIndex(userId)
  list.unshift(tile)
  writeIndex(userId, list)
  return tile
}

/**
 * The default display category for a tile's report kind. A tile that reports a
 * count shows a "Count" chip, a duration shows "Duration", and so on. Returns
 * undefined for an unknown / absent kind so the caller can fall back to 'Custom'.
 */
const CATEGORY_FROM_KIND: Record<ReportKind, string> = {
  intake: 'Intake',
  count: 'Count',
  duration: 'Duration',
  rating: 'Rating',
  measure: 'Measure',
  money: 'Money',
  done: 'Done',
}
function categoryFromKind(kind?: ReportKind): string | undefined {
  return kind ? CATEGORY_FROM_KIND[kind] : undefined
}

/** A sealed tile's html is capped so one paste can never blow the storage budget. */
const MAX_TILE_HTML = 1024 * 1024 // 1MB

/**
 * The ONE install pipe. Every platform pillar drops a tile through here: the
 * Library upload paste box, the MCP's future upload_tile, and the Arts District.
 * Validates the envelope, derives the display category, creates the tile, then
 * seeds any design / color / size onto its skin. Returns the new tile, or null
 * on any validation failure so the caller can show a friendly message.
 */
function importTile(userId: string, envelope: TileEnvelope): Tile | null {
  if (!envelope || typeof envelope !== 'object') return null
  const { name, html } = envelope
  if (typeof name !== 'string' || name.trim().length === 0) return null
  if (typeof html !== 'string' || html.length === 0) return null
  if (html.length > MAX_TILE_HTML) return null

  // The envelope's DECLARED stream rides onto the tile so a later share or
  // publish round-trips the report contract intact (PATCH21): without this a
  // shared beer tile silently loses goalDirection:'down' and flips scoring mode.
  const category = envelope.category || categoryFromKind(envelope.kind) || 'Custom'
  const tile = createTile(userId, {
    name,
    html,
    category,
    key: typeof envelope.key === 'string' && envelope.key.trim() !== '' ? envelope.key.trim() : undefined,
    label: typeof envelope.label === 'string' && envelope.label.trim() !== '' ? envelope.label.trim() : undefined,
    kind: envelope.kind ?? undefined,
    goalDirection:
      envelope.goalDirection === 'up' || envelope.goalDirection === 'down'
        ? envelope.goalDirection
        : undefined,
  })

  // Seed only the skin fields the envelope actually carries. An empty-string
  // color / design (or a missing field) is treated as "use the default": guard
  // each one explicitly so intent is clear and a blank never overwrites a default.
  const patch: Partial<Skin> = {}
  if (envelope.design != null && envelope.design !== '') patch.design = envelope.design
  if (envelope.color != null && envelope.color !== '') patch.color = envelope.color
  if (envelope.size != null) patch.size = envelope.size
  if (patch.design != null || patch.color != null || patch.size != null) {
    tileSkin.set(userId, tile.id, patch)
  }

  return tile
}

/**
 * Adopt a tile that already has an id (e.g. one pulled from the server `tiles`
 * table — an MCP-built or cross-device tile). No-op if a tile with that id is
 * already in the local index, so a re-sync never duplicates. Additive: the
 * localStorage v1 stays the source for everything else; this just lets the
 * server sync layer (lib/tiles/tileSync.ts) fold server rows into the index.
 */
function adoptTile(userId: string, tile: Tile): boolean {
  const list = readIndex(userId)
  if (list.some((t) => t.id === tile.id)) return false
  list.unshift(tile)
  writeIndex(userId, list)
  return true
}

/**
 * Fold a server tile into the local index with last-write-wins: adopt it if new,
 * overwrite the local copy when the server row is STRICTLY newer (a cross-device
 * edit made elsewhere), else leave the newer-or-equal local copy untouched (a
 * local edit still wins). Preserves the server `updatedAt` so timestamps stay
 * comparable across devices. Used by the sync layer instead of adoptTile so an
 * edit made on another device actually reaches this one.
 */
function syncServerTile(userId: string, tile: Tile): 'new' | 'updated' | 'stale' {
  const list = readIndex(userId)
  const existing = list.find((t) => t.id === tile.id)
  if (!existing) {
    list.unshift(tile)
    writeIndex(userId, list)
    return 'new'
  }
  if (tile.updatedAt > existing.updatedAt) {
    existing.name = tile.name
    existing.html = tile.html
    if (tile.category !== undefined) existing.category = tile.category
    else delete existing.category
    existing.updatedAt = tile.updatedAt
    writeIndex(userId, list)
    return 'updated'
  }
  return 'stale'
}

function renameTile(userId: string, id: string, name: string): Tile | undefined {
  const list = readIndex(userId)
  const tile = list.find((t) => t.id === id)
  if (!tile) return undefined
  tile.name = name.trim() || tile.name
  tile.updatedAt = Date.now()
  writeIndex(userId, list)
  return tile
}

function updateHtml(userId: string, id: string, html: string): Tile | undefined {
  const list = readIndex(userId)
  const tile = list.find((t) => t.id === id)
  if (!tile) return undefined
  tile.html = html
  tile.updatedAt = Date.now()
  writeIndex(userId, list)
  return tile
}

function deleteTile(userId: string, id: string) {
  writeIndex(
    userId,
    readIndex(userId).filter((t) => t.id !== id),
  )
  if (!hasStorage()) return
  try {
    window.localStorage.removeItem(dataKey(userId, id))
  } catch {
    /* ignore */
  }
}

const MAX_TILE_DATA = 512 * 1024 // ~512KB per tile, protects the shared localStorage budget

/** Persist a tile's data. Returns whether the write actually landed so callers
 *  never tell the user "Saved" for a payload that was silently dropped (oversized
 *  or quota-blocked). When a Supabase project is configured (env vars present) the
 *  write goes there so it syncs across devices; otherwise it stays in localStorage. */
async function saveData(userId: string, id: string, data: TileData): Promise<boolean> {
  if (await remoteSave(`${userId}:${id}`, data)) return true
  if (!hasStorage()) return false
  try {
    const json = JSON.stringify(data)
    if (json.length > MAX_TILE_DATA) return false // oversized payload, skip rather than blow the quota
    window.localStorage.setItem(dataKey(userId, id), json)
    return true
  } catch {
    /* quota / blocked. fail quiet */
    return false
  }
}

async function loadData(userId: string, id: string): Promise<TileData> {
  const remote = await remoteLoad(`${userId}:${id}`)
  if (remote != null) return remote as TileData
  if (!hasStorage()) return []
  try {
    const raw = window.localStorage.getItem(dataKey(userId, id))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

/**
 * Which tiles currently HAVE saved data (localStorage scan). Powers the gear
 * panel's "wipe the demo data" list: every id here still keeps its card — only
 * what's inside can be detonated. Supabase-synced data won't appear in this
 * scan (v1), but clearData still clears both stores.
 */
function listDataIds(userId: string): string[] {
  if (!hasStorage()) return []
  const prefix = `vitality:${userId}:tile:`
  const ids: string[] = []
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(prefix) && k.endsWith(':data')) {
        ids.push(k.slice(prefix.length, -':data'.length))
      }
    }
  } catch {
    /* ignore */
  }
  return ids
}

/**
 * Detonate what's INSIDE a tile — the card survives, its data goes black.
 * Clears both stores (Supabase row if configured, localStorage always) so the
 * tile renders its empty state on next load.
 */
async function clearData(userId: string, id: string): Promise<void> {
  await remoteClear(`${userId}:${id}`)
  if (!hasStorage()) return
  try {
    window.localStorage.removeItem(dataKey(userId, id))
  } catch {
    /* ignore */
  }
}

/**
 * One-time migration from the BUILD71 single-tile key, where
 * vitality:<userId>:tile:draft held the saved data array directly (literal id
 * "draft", no html persisted). If the registry is empty and that key exists,
 * adopt its data into a real tile (html was never stored back then, so the
 * caller supplies a default), then remove the legacy key. Guarded on an empty
 * index so it never runs twice.
 */
async function migrateLegacy(userId: string, defaultHtml: string): Promise<Tile | undefined> {
  if (!hasStorage()) return undefined
  if (readIndex(userId).length > 0) return undefined
  let legacyData: TileData = null
  try {
    const raw = window.localStorage.getItem(legacyKey(userId))
    if (!raw) return undefined
    legacyData = JSON.parse(raw)
  } catch {
    return undefined
  }
  const tile = createTile(userId, { name: 'My first tile', html: defaultHtml })
  // Confirm the write landed before dropping the only copy of the legacy data
  // (the Supabase path is a network write, so a fire-and-forget delete could lose it).
  const ok = await saveData(userId, tile.id, legacyData)
  if (ok) {
    try {
      window.localStorage.removeItem(legacyKey(userId))
    } catch {
      /* ignore */
    }
  }
  return tile
}

export const tileStore = {
  listTiles,
  getTile,
  createTile,
  importTile,
  adoptTile,
  syncServerTile,
  renameTile,
  updateHtml,
  deleteTile,
  saveData,
  loadData,
  listDataIds,
  clearData,
  migrateLegacy,
}
