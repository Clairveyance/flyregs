-- RC: "clean up all... gating and security." Closes a gap flagged and
-- deliberately deferred in the 2026-08-11 downgrade-data-retention round:
-- user_aircraft got a real UPDATE-only cap-gate (has_visible_fleet_access()),
-- but the identical fix was NOT extended to synced_folders at the time --
-- a downgraded user could still read/write their over-cap folder rows via
-- raw REST, even though the app's own UI already correctly hides them.
--
-- That round's stated reason for deferring: "a correct fix needs a
-- rank-aware, atomic reorder RPC... the existing per-row drag-order
-- mechanic can't be safely replicated as a flat RLS cap-check without
-- either blocking legitimate reordering of the 'kept' set or racing
-- against the sync merge." Re-examined that reasoning against what
-- has_visible_fleet_access() ACTUALLY does (checked via
-- pg_get_functiondef, not assumed): it is NOT per-row or rank-aware at
-- all -- it's a single boolean, "is this user's TOTAL row count <= their
-- cap," applied only as an UPDATE-time WITH CHECK, with SELECT/DELETE left
-- completely ungated. That simpler shape sidesteps both concerns: (1)
-- "blocks legitimate reordering" only bites a user who is CURRENTLY over
-- cap, which can only happen via a downgrade (INSERT already can't create
-- new folders past the cap, via the existing enforce_folder_cap()
-- trigger) -- i.e. it only ever affects the exact population this fix
-- targets, and pushes them toward deleting down to their cap first,
-- exactly like the aircraft flow already does; (2) "races against the
-- sync merge" was specifically about gating SELECT, which this does not
-- do -- mergeFolders still sees every row via an unchanged SELECT policy,
-- so nothing looks "gone" and nothing gets wrongly re-pushed.
--
-- Net: this is the exact same pattern as user_aircraft, applied to
-- synced_folders. No new RPC needed.
CREATE OR REPLACE FUNCTION public.has_visible_folder_access()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (select count(*) from synced_folders where user_id = auth.uid() and deleted = false)
         <= public.folder_visible_cap();
$function$;

DROP POLICY IF EXISTS users_manage_own_synced_folders ON synced_folders;

CREATE POLICY folders_own_select ON synced_folders
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY folders_own_delete ON synced_folders
  FOR DELETE
  USING (auth.uid() = user_id);

-- Cap enforcement on creation already lives in the enforce_folder_cap()
-- BEFORE INSERT trigger (also checks has_pro_access) -- this policy just
-- restores plain ownership-scoped INSERT, matching user_aircraft_own_insert's
-- identical shape (no WITH CHECK cap clause at the RLS layer, since the
-- trigger already covers it and firing at both layers would be redundant).
CREATE POLICY folders_own_insert ON synced_folders
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY folders_own_update ON synced_folders
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND public.has_visible_folder_access());
