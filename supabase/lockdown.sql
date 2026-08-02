-- Vitality Base — close the open door
--
-- Run this ONCE in your own Supabase project (Dashboard → SQL Editor → paste → Run).
--
-- WHAT WAS WRONG
-- sync.sql and tiles.sql shipped a policy of `for all using (true) with check
-- (true)` plus an explicit grant to `anon`. Combined with the anon/publishable
-- key living in the browser bundle, that meant anyone who could load the
-- deployed site could read, rewrite and DELETE every row. Verified against the
-- live project: select 200, insert 201, delete 204.
--
-- WHAT THIS DOES
-- Removes those policies and revokes the grants. RLS stays enabled with NO
-- policy, so `anon` and `authenticated` are refused everything. The service /
-- secret key bypasses RLS by design and keeps working — and it only ever lives
-- on the server (lib/server/db.ts), behind the password gate in middleware.ts.
--
-- RUN THIS ONLY AFTER SUPABASE_SECRET_KEY is set and the app has been restarted,
-- otherwise the board loses its backend until you do.

-- ── tile_data ────────────────────────────────────────────────────────────────
drop policy if exists "tile_data open" on public.tile_data;

alter table public.tile_data enable row level security;

revoke all on table public.tile_data from anon, authenticated;

-- ── tiles ────────────────────────────────────────────────────────────────────
drop policy if exists "tiles open" on public.tiles;

alter table public.tiles enable row level security;

revoke all on table public.tiles from anon, authenticated;

-- ── auth_attempts ────────────────────────────────────────────────────────────
-- The failed-PIN counter. A six-digit code is only safe if the door stops
-- answering after a few wrong tries (see lib/server/loginGuard.ts), and that
-- counter cannot live in memory: serverless gives you neither one process nor
-- one instance, so an in-memory count resets constantly and is trivially
-- walked past. One shared row is the only thing every instance sees.
--
-- Never reachable from a browser: no policy, no grants, secret key only.
create table if not exists public.auth_attempts (
  id           text primary key,
  fails        integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

alter table public.auth_attempts enable row level security;

revoke all on table public.auth_attempts from anon, authenticated;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Both tables must show rowsecurity = true and zero policies.
select
  c.relname                                   as tabelle,
  c.relrowsecurity                            as rls_an,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('tile_data', 'tiles', 'auth_attempts');

-- After running, confirm from a terminal that the public key is now useless:
--   curl -s -o /dev/null -w "%{http_code}\n" \
--     "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/tile_data?select=tile_id&limit=1" \
--     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
-- Expect 401 or an empty result — anything that still returns your rows means
-- a policy or grant survived.
