-- ============================================================================
-- Rename "User Handle" to "Callsign" + enforce real uniqueness -- 2026-08-02
--
-- RC: "in the main menu, we need to change 'handle' to 'Callsign' for the
-- user. that's much more aviation based and more fun. btw - our system
-- does need to monitor these. if a callsign already exists, it must warn
-- the user to put something different. we can't have two same callsigns
-- in the system."
--
-- Previously there was NO uniqueness enforcement at all -- account.tsx's
-- handleSaveHandle() called supabase.auth.updateUser({data:{display_name}})
-- directly, and any two users could set the identical value. Confirmed
-- zero existing collisions among real users before building this.
--
-- The obvious design (a unique index directly on auth.users) doesn't work
-- here: `create unique index ... on auth.users (...)` fails live with
-- "42501: must be owner of table users" -- Supabase's auth schema tables
-- are owned by supabase_auth_admin, and this project's Management API
-- connection (role: postgres) isn't a member of that role (checked via
-- pg_has_role), so it can't be granted after the fact either. Rather than
-- fight Supabase's managed auth schema, the callsign's uniqueness is
-- tracked in a small table this project fully owns (public.
-- callsign_registry), while auth.users.raw_user_meta_data.display_name
-- stays the actual DISPLAY value everything already reads (getDisplayName,
-- the leaderboard RPCs, shared-folder collaborator names) -- zero ripple
-- to any existing read site.
--
-- Client flow (see account.tsx): call set_callsign() FIRST to reserve the
-- name (this is the real uniqueness gate), and only once that succeeds,
-- call the existing supabase.auth.updateUser({data:{display_name}}) same
-- as before to actually set the visible value. Reserve-then-write, not
-- the other way around: if the write step ever failed after reservation,
-- the user just has a stale reservation they can overwrite by retrying
-- their own name -- but if it were write-then-reserve and the RESERVE
-- step failed, auth.users could briefly show a colliding, unprotected
-- display_name, exactly what this feature exists to prevent.
-- ============================================================================

create table if not exists public.callsign_registry (
  user_id uuid primary key references auth.users(id) on delete cascade,
  callsign text not null,
  callsign_lower text generated always as (lower(callsign)) stored,
  updated_at timestamptz not null default now()
);

create unique index if not exists callsign_registry_lower_unique_idx
on public.callsign_registry (callsign_lower);

alter table public.callsign_registry enable row level security;
-- No policies added deliberately -- all access goes through the SECURITY
-- DEFINER functions below, so anon/authenticated get zero direct access
-- to this table (RLS with no policies = default deny).

-- One-time backfill so anyone who already set a "handle" keeps their name
-- reserved going forward, instead of a new user being able to take it out
-- from under them the moment this ships.
insert into public.callsign_registry (user_id, callsign, updated_at)
select id, raw_user_meta_data->>'display_name', now()
from auth.users
where raw_user_meta_data->>'display_name' is not null and raw_user_meta_data->>'display_name' <> ''
on conflict (user_id) do nothing;

create or replace function public.set_callsign(p_callsign text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_trimmed text := nullif(trim(p_callsign), '');
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- Clearing your callsign frees the name for anyone else.
  if v_trimmed is null then
    delete from callsign_registry where user_id = v_uid;
    return;
  end if;

  if length(v_trimmed) > 40 then
    v_trimmed := left(v_trimmed, 40);
  end if;

  if exists (
    select 1 from callsign_registry
    where callsign_lower = lower(v_trimmed) and user_id <> v_uid
  ) then
    raise exception 'CALLSIGN_TAKEN';
  end if;

  insert into callsign_registry (user_id, callsign, updated_at)
  values (v_uid, v_trimmed, now())
  on conflict (user_id) do update set callsign = excluded.callsign, updated_at = now();
exception
  when unique_violation then
    raise exception 'CALLSIGN_TAKEN';
end;
$function$;

grant execute on function public.set_callsign(text) to authenticated;
