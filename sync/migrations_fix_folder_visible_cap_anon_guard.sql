-- Fixes a P3 finding from the 2026-08-22 gating audit: folder_visible_cap()
-- was missing the `auth.uid() is null -> 0` guard that its sibling
-- fleet_visible_cap() already has, so an anonymous caller fell through to
-- the "no entitlement row" branch and got 2147483647 (uncapped). Harmless
-- today (anon can't write synced_folders, confirmed by the audit), but a
-- trap for whoever adds an anon-readable folder path later without
-- re-deriving this. Brings the two cap functions back in line.
CREATE OR REPLACE FUNCTION public.folder_visible_cap()
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select case
    when auth.uid() is null then 0
    -- No entitlement row at all -> uncapped, deliberately, matching
    -- fleet_visible_cap()'s exact fail-open reasoning: a sync hiccup must
    -- never make a paying customer's folders look capped.
    when not exists (select 1 from user_entitlements e where e.user_id = auth.uid())
      then 2147483647
    when coalesce((select e.is_premium from user_entitlements e where e.user_id = auth.uid()), false)
      then 2147483647   -- Premium: unlimited
    -- Plus and Pro share the same numeric cap (PRO_FOLDER_CAP in
    -- src/lib/folders.ts, kept its historical name -- see this file's own
    -- header comment for why a rename wasn't worth the churn) -- Pro's
    -- only difference from Plus here is that ITS folders can also be
    -- synced, once the separate "Back up & sync" toggle is turned on.
    when public.has_plus_access()
      then 3
    else 0              -- Free: folders aren't part of any free feature
  end;
$function$;
