-- Fix: synced_folders had ZERO server-side cap enforcement of any kind --
-- no trigger, no capped-read RPC, no downgrade-gate component (unlike
-- user_aircraft, which already has a full read-side fix from 2026-08-05:
-- migrations_tier_cap_enforcement.sql). PLUS_FOLDER_CAP (=3, src/lib/
-- folders.ts) was purely a client-side slice in saved.tsx -- confirmed live
-- via the 2026-08-10 tier-gate audit: a Plus-tier account created 6 folders
-- directly via REST, all 6 succeeded and all 6 were readable back.
--
-- This migration closes the CREATE side only, matching
-- migrations_fix_aircraft_cap_insert_enforcement's exact trigger pattern.
-- It deliberately does NOT attempt the read-side/downgrade-gate half of the
-- aircraft parity (a capped get_folder_summary()-style RPC + a
-- FolderDowngradeGate UI component) -- that's a materially bigger change
-- touching saved.tsx's live data-fetching on a heavily-used screen, and
-- deserves its own careful build+verify pass rather than being rushed in
-- alongside this batch. Flagged to RC as a real, separate follow-up.
--
-- Cost note: unlike aircraft (which drives AD-alert-matching cost) or
-- offline downloads (real storage cost), folders are lightweight rows with
-- no meaningful backend cost -- PLUS_FOLDER_CAP is a pure tier-differentiation
-- lever, not a cost control. So the un-fixed read-side gap (a Plus user
-- keeping more than 3 folders after this trigger stops NEW ones) is a
-- monetization-fairness issue, not a cost or data-exposure one.

CREATE OR REPLACE FUNCTION public.folder_visible_cap()
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select case
    -- No entitlement row at all -> uncapped, deliberately, matching
    -- fleet_visible_cap()'s exact fail-open reasoning: a sync hiccup must
    -- never make a paying customer's folders look capped.
    when not exists (select 1 from user_entitlements e where e.user_id = auth.uid())
      then 2147483647
    when coalesce((select e.is_premium from user_entitlements e where e.user_id = auth.uid()), false)
      then 2147483647   -- Premium: unlimited
    else 3              -- Free / Plus / Pro: PLUS_FOLDER_CAP (src/lib/folders.ts)
  end;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_folder_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF (SELECT count(*) FROM synced_folders WHERE user_id = NEW.user_id AND deleted = false) >= public.folder_visible_cap() THEN
    RAISE EXCEPTION 'Folder limit reached for your current plan';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_folder_cap ON public.synced_folders;
CREATE TRIGGER trg_enforce_folder_cap
  BEFORE INSERT ON public.synced_folders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_folder_cap();
