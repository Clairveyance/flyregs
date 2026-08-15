-- RC, 2026-08-14, direct correction to the 2026-08-11 "sync features Pro
-- not Plus" pass (migrations_fix_sync_features_pro_not_plus.sql /
-- migrations_fix_downgrade_retains_over_cap_data.sql): "my quote has
-- nothing to do with folders, h/l, etc. -- ONLY the 'bu/s' feature itself.
-- that feature is a separate thing from folders/notes/bookmarks/highlights.
-- All of those things are supposed to be part of Plus. It's just the bu/s
-- feature that gets gated to Pro/Prem."
--
-- Those two earlier migrations moved the WHOLE feature family (create +
-- sync) to Pro, on the mistaken premise that RC's "back up sync is Pro"
-- instruction covered base folder/note/bookmark/highlight creation too. It
-- didn't -- creating and using these locally is Plus; only pushing them to
-- Supabase for cross-device access ("Back up & sync", the literal toggle in
-- notes.tsx/saved.tsx) requires Pro.
--
-- This migration ONLY touches folder_visible_cap() -- the value that
-- decides how many folders a user can have/see AT ALL, local-only or
-- synced. It deliberately does NOT touch enforce_folder_cap(),
-- enforce_bookmark_plus_gate(), enforce_note_plus_gate(), or
-- enforce_folder_item_access() (all still correctly require Pro): those
-- triggers only fire on INSERT into the synced_* tables, which only ever
-- happens via syncPush*() -- and syncPush*() itself no-ops unless
-- isSyncEnabled() is true, which the client only ever sets via the
-- Pro-gated "Back up & sync" toggle. A Plus user's local-only folders/
-- notes/bookmarks never reach those triggers at all under normal
-- operation; leaving them at has_pro_access() is what keeps a raw-REST
-- bypass of the client's sync toggle correctly blocked server-side too --
-- the actual substance of "the bu/s feature is gated to Pro/Prem."
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
