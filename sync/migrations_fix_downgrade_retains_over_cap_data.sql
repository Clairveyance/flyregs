-- RC, 2026-08-11, direct correction: "downgrades don't keep any data
-- associated with the higher tier. If that data type is also avail with
-- the tier being moved to, then that's fine." Found during the app-wide
-- gating sweep: fleet_visible_cap() and the curated read path that uses it
-- (get_fleet_summary) already correctly go all-or-nothing once a user's
-- owned count exceeds their current tier's cap -- but the RAW TABLE
-- underneath (user_aircraft) only ever checked OWNERSHIP, never whether the
-- caller's fleet still fits under their current cap. A user who owned 3
-- aircraft as Premium and downgrades to Pro (cap 1) could still read/write
-- all 3 via direct REST.
--
-- FIRST DESIGN (superseded within this same session, before ever shipping
-- past live testing) also cap-gated SELECT, mirroring get_fleet_summary's
-- all-or-nothing hide. Live testing caught a real, serious regression
-- before it went anywhere near production traffic: Postgres RLS requires a
-- row to be visible under a SELECT policy as a PREREQUISITE for UPDATE or
-- DELETE to touch it at all -- a command-specific policy that's more
-- permissive than SELECT does not override that. Confirmed live
-- (stack-depth aside): a cap-gated SELECT made DELETE silently affect 0
-- rows for every over-cap aircraft, no error, Content-Range: */0, even
-- though user_aircraft_own_delete's own USING clause has no cap check at
-- all. That's not just a raw-REST theoretical -- AircraftDowngradeGate.tsx
-- (the actual, shipped, RC-approved downgrade UX) depends on exactly this:
-- getOwnedAircraftOldestFirst() is a plain ownership SELECT that needs to
-- see every owned aircraft including the hidden ones (to list them as
-- choices), and keepOnlyAircraft() is a plain ownership DELETE that needs
-- to actually remove the ones not kept. A cap-gated SELECT would have
-- emptied the picker's list and made "keep this one" a silent no-op,
-- permanently trapping a real downgraded user in their own lockout modal.
--
-- REVISED DESIGN (this file, as applied): SELECT and DELETE stay
-- ownership-only, exactly as before -- reading your own data and deleting
-- your way back under cap both keep working unconditionally, and
-- get_fleet_summary() (a separate, curated RPC with its own internal cap
-- logic) is still what the app's normal UI uses for browsing, so normal
-- in-app use is unaffected either way. Only UPDATE is cap-gated: a
-- downgraded user can still see and delete their excess aircraft, just not
-- keep actively editing them. Narrower than the first draft, but correct,
-- and it's the same shape independently arrived at for folders below
-- (gate the ability to keep USING excess data; never gate the ability to
-- see it well enough to get rid of it).

-- SECURITY DEFINER is load-bearing, not incidental: this function is used
-- INSIDE user_aircraft's own RLS policy below, and its internal count(*)
-- targets that same table. Without SECURITY DEFINER, that nested count is
-- itself subject to user_aircraft's RLS -- which calls this function again
-- to evaluate -- infinite recursion, confirmed live ("stack depth limit
-- exceeded", 54001) before this was added. SECURITY DEFINER makes the
-- internal count bypass RLS and see the true row count directly, breaking
-- the cycle. Safe to elevate: the count is hard-scoped to auth.uid(), so it
-- can never reveal or affect another user's rows.
CREATE OR REPLACE FUNCTION public.has_visible_fleet_access()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select (select count(*) from user_aircraft where user_id = auth.uid())
         <= public.fleet_visible_cap();
$function$;

-- user_aircraft: only UPDATE is cap-gated -- see the design note above for
-- why SELECT and DELETE deliberately are not. INSERT stays ownership-only
-- too (enforce_aircraft_cap()'s existing BEFORE INSERT trigger already
-- blocks going OVER cap; a redundant RLS check here would just duplicate
-- it, and unlike UPDATE, INSERT has no pre-existing row to be blocked by
-- the SELECT-visibility prerequisite in the first place).
DROP POLICY IF EXISTS user_aircraft_own_rows ON public.user_aircraft;
DROP POLICY IF EXISTS user_aircraft_own_select ON public.user_aircraft;
DROP POLICY IF EXISTS user_aircraft_own_update ON public.user_aircraft;
DROP POLICY IF EXISTS user_aircraft_own_insert ON public.user_aircraft;
DROP POLICY IF EXISTS user_aircraft_own_delete ON public.user_aircraft;

CREATE POLICY user_aircraft_own_select ON public.user_aircraft
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY user_aircraft_own_update ON public.user_aircraft
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND public.has_visible_fleet_access());

CREATE POLICY user_aircraft_own_insert ON public.user_aircraft
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_aircraft_own_delete ON public.user_aircraft
  FOR DELETE USING (auth.uid() = user_id);

-- user_aircraft_reminders: same UPDATE-only shape, extended to also cover
-- INSERT (a downgraded user shouldn't be able to add a NEW reminder to an
-- excess aircraft either, not just edit an existing one) -- both matter
-- here because unlike user_aircraft's own UPDATE, there's no separate
-- BEFORE-INSERT trigger already covering this table's create path. SELECT
-- and DELETE are untouched: still ownership + has_pro_access exactly as
-- before, so a downgraded user can still see and clean up reminders on any
-- of their own aircraft, hidden or not.
--
-- user_aircraft_equipment was investigated and deliberately left alone:
-- its own existing policy already requires is_premium = true outright
-- (equipment is Premium-only, not Pro+), and fleet_visible_cap() is always
-- unlimited for Premium -- so an equipment row can never legitimately
-- exist on an over-cap aircraft in the first place. Nothing to gate.
DROP POLICY IF EXISTS user_aircraft_reminders_own_rows ON public.user_aircraft_reminders;

CREATE POLICY user_aircraft_reminders_select ON public.user_aircraft_reminders
  FOR SELECT USING (
    (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_reminders.user_aircraft_id AND ua.user_id = auth.uid()))
    AND has_pro_access(auth.uid())
  );

CREATE POLICY user_aircraft_reminders_delete ON public.user_aircraft_reminders
  FOR DELETE USING (
    (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_reminders.user_aircraft_id AND ua.user_id = auth.uid()))
    AND has_pro_access(auth.uid())
  );

CREATE POLICY user_aircraft_reminders_insert ON public.user_aircraft_reminders
  FOR INSERT WITH CHECK (
    (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_reminders.user_aircraft_id AND ua.user_id = auth.uid()))
    AND has_pro_access(auth.uid())
    AND public.has_visible_fleet_access()
  );

CREATE POLICY user_aircraft_reminders_update ON public.user_aircraft_reminders
  FOR UPDATE
  USING (
    (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_reminders.user_aircraft_id AND ua.user_id = auth.uid()))
    AND has_pro_access(auth.uid())
  )
  WITH CHECK (
    (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_reminders.user_aircraft_id AND ua.user_id = auth.uid()))
    AND has_pro_access(auth.uid())
    AND public.has_visible_fleet_access()
  );

-- folder_visible_cap(): fixing a second, independent stale-drift bug found
-- while investigating the above. This function still returned 3 for
-- Free/Plus ("else 3 -- Free / Plus / Pro: PLUS_FOLDER_CAP"), left over
-- from before folders moved from Plus to Pro earlier in this same round
-- (migrations_fix_sync_features_pro_not_plus.sql) -- that fix updated the
-- INSERT-time trigger and every client gate, but missed this cap value
-- itself. A Free/Plus account (never-Pro, or freshly downgraded past Pro
-- straight to Plus/Free) has no business with a nonzero folder cap at all
-- now that folders require Pro outright. Mirrors fleet_visible_cap()'s
-- exact tier-branch shape.
--
-- synced_folders/synced_folder_items themselves were investigated for the
-- identical raw-table gap and deliberately left otherwise unchanged --
-- see the note near the bottom of this file, in the previous version of
-- this migration's history. Short version: synced_folders is local-first
-- (AsyncStorage + sync.ts's mergeFolders/mergeFolderItems), and a
-- cap-based RLS restriction on it would make already-synced-down "excess"
-- rows silently vanish from a SELECT the merge logic depends on, which
-- mergeFolders reads as "gone remotely" and re-pushes -- straight into
-- whatever WITH CHECK gate stops it, as a repeating sync failure for a
-- real paying customer, not a quiet cap. The user_aircraft/DELETE finding
-- above is the same shape of risk, confirmed for real this time rather
-- than reasoned out in advance -- both point the same direction: don't
-- gate SELECT on a locally-cached or delete-recoverable table. Fixing
-- folders properly needs a rank-aware, atomic reorder RPC (mirrors
-- keepOnlyAircraft's shape), not an RLS policy -- real feature work, not a
-- policy tightening, so it's flagged to RC rather than shipped fragile.
CREATE OR REPLACE FUNCTION public.folder_visible_cap()
 RETURNS integer LANGUAGE sql STABLE
AS $function$
  select case
    -- No entitlement row at all -> uncapped, deliberately, matching
    -- fleet_visible_cap()'s exact fail-open reasoning: a sync hiccup must
    -- never make a paying customer's folders look capped.
    when not exists (select 1 from user_entitlements e where e.user_id = auth.uid())
      then 2147483647
    when coalesce((select e.is_premium from user_entitlements e where e.user_id = auth.uid()), false)
      then 2147483647   -- Premium: unlimited
    when coalesce((select e.is_pro from user_entitlements e where e.user_id = auth.uid()), false)
      then 3            -- Pro: PRO_FOLDER_CAP (src/lib/folders.ts)
    else 0              -- Free / Plus: Back up & sync isn't part of the tier
  end;
$function$;
