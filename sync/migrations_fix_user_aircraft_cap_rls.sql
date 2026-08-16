-- SUPERSEDED by migrations_fix_user_aircraft_select_returning.sql, applied
-- immediately after this one in the same session -- this version's SELECT
-- policy broke the "Add Aircraft" insert flow (INSERT ... RETURNING) due
-- to a Postgres RLS/snapshot landmine, caught live before it ever reached
-- users. Kept here as the real historical record of what was applied and
-- why the follow-up fix was needed; see the superseding file for the full
-- explanation and the actual final SELECT policy definition.
--
-- Real, live-confirmed gap found during B34 readiness tier-gate audit
-- (2026-08-16): user_aircraft's SELECT policy was ownership-only, with no
-- fleet_visible_cap() awareness -- only the get_fleet_summary() RPC
-- applied the cap. A downgraded user (Premium -> Pro, cap drops to 1)
-- still saw ALL their aircraft via a direct table query AND via
-- my-aircraft/[id].tsx's own detail-screen fetch (which queries the raw
-- table directly, not the RPC). Confirmed live with disposable test
-- accounts: 3 aircraft inserted at Premium, downgraded to Pro (cap=1),
-- direct REST select still returned all 3; get_fleet_summary() correctly
-- returned 1.
--
-- The fix already exists and is already CORRECT -- it's just not applied
-- to SELECT. is_aircraft_visible(p_aircraft_id) replicates
-- get_fleet_summary()'s exact ranking logic (row_number() over
-- created_at,id, capped by fleet_visible_cap()) and is ALREADY used in
-- user_aircraft_own_update's WITH CHECK clause. This migration adds the
-- same check to the SELECT policy so reading is capped the same way
-- writing already is.
--
-- Scope: SELECT only. UPDATE already enforces this (own_update's WITH
-- CHECK). INSERT is a different concern (enforce_aircraft_cap trigger).
-- DELETE deliberately left ownership-only -- letting a user delete their
-- own data even while it's hidden due to a downgrade isn't a security
-- gap (no information disclosure, no cross-account risk), so it doesn't
-- need this same visibility check.
--
-- collaborators_view_shared_aircraft (the OTHER select policy, for
-- shared/non-owned aircraft) is untouched -- has_aircraft_access()
-- already independently requires is_premium=true on BOTH the owner and
-- the collaborator, which is at least as strict as fleet_visible_cap()'s
-- own ">1" check for shared visibility.

drop policy if exists user_aircraft_own_select on public.user_aircraft;
create policy user_aircraft_own_select on public.user_aircraft
  for select
  using (auth.uid() = user_id and is_aircraft_visible(id));
