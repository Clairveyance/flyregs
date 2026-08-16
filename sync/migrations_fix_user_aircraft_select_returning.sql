-- Fixes a real regression introduced by the previous migration in this
-- session (migrations_fix_user_aircraft_cap_rls.sql), caught by live
-- testing before it was committed -- never shipped.
--
-- That migration added `is_aircraft_visible(id)` to
-- user_aircraft_own_select's USING clause to close a real cap-bypass gap
-- (a downgraded user could still read all their aircraft via a direct
-- table query). Confirmed live: it DID close that gap. But it also broke
-- the normal "Add Aircraft" flow, which inserts with
-- `Prefer: return=representation` (supabase-js `.insert().select()`).
--
-- Root cause, confirmed live with a disposable account: Postgres checks a
-- RETURNING row against the table's SELECT policy, but INSERT...RETURNING
-- evaluates that check using the snapshot from the START of the
-- statement -- so a self-referencing lookup like is_aircraft_visible(id),
-- which re-queries user_aircraft BY THAT SAME id to find the row's own
-- rank, can never find a row that statement is itself in the middle of
-- inserting. A bare insert (no RETURNING) succeeds every time; the exact
-- same insert with RETURNING got a 403. Confirmed the row's OWN detail
-- fetch (a separate, later statement) sees it fine -- this is specific to
-- the same-statement RETURNING check, not a general logic error.
--
-- Fix: for user_aircraft_own_select only, stop going through
-- is_aircraft_visible(id) (which requires re-finding the row by id) and
-- instead rank the row using its OWN columns, which RLS provides
-- directly from the row under check -- no self-lookup needed, so there's
-- nothing for the statement-start snapshot to hide. Counts only OTHER
-- rows, which for a fresh insert already existed before this statement
-- began and are correctly visible.
--
-- is_aircraft_visible() itself is untouched -- its other 2 call sites
-- (user_aircraft_reminders' INSERT/UPDATE WITH CHECK, in
-- migrations_fix_visible_cap_per_row.sql) look up a DIFFERENT,
-- already-existing aircraft row via a foreign key, so they never hit this
-- same-statement trap and don't need this fix. user_aircraft_own_update's
-- WITH CHECK also still calls is_aircraft_visible(id) safely, since an
-- UPDATE's target row already existed before the statement started.
--
-- First attempt at this (inlining the count(*) subquery directly in the
-- policy, no function) hit a SECOND bug before it ever shipped either:
-- infinite recursion (42P17), because a plain subquery against
-- user_aircraft inside its own SELECT policy re-triggers that same
-- policy on itself. The original is_aircraft_visible() avoided this by
-- being SECURITY DEFINER (runs as the function owner, not subject to
-- RLS). So this fix keeps that same SECURITY DEFINER wrapper, just with
-- a signature that takes the row's own (user_id, created_at, id) as
-- direct arguments instead of re-finding the row by id -- RLS hands a
-- USING clause the current row's real column values regardless of
-- whether that row is mid-INSERT, so there's nothing left to hide from
-- the statement-start snapshot.
create or replace function public.is_aircraft_visible_row(p_user_id uuid, p_created_at timestamptz, p_aircraft_id uuid)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select (
    select count(*) from public.user_aircraft other
    where other.user_id = p_user_id
      and (other.created_at, other.id) < (p_created_at, p_aircraft_id)
  ) < public.fleet_visible_cap();
$$;

grant execute on function public.is_aircraft_visible_row(uuid, timestamptz, uuid) to authenticated;

-- Re-verified live after this fix: insert-with-RETURNING succeeds again
-- at Premium; the downgrade-to-Pro cap enforcement from the previous
-- migration still holds (direct query capped to 1, locked aircraft detail
-- fetch empty, re-upgrade restores all 3). See
-- scripts/aircraft_cap_rls_test.py.

drop policy if exists user_aircraft_own_select on public.user_aircraft;
create policy user_aircraft_own_select on public.user_aircraft
  for select
  using (
    auth.uid() = user_id
    and public.is_aircraft_visible_row(user_id, created_at, id)
  );
