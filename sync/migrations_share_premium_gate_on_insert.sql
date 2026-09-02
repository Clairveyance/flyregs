-- The Premium share gate was enforced on UPDATE only (2026-09-03)
--
-- trg_enforce_folder_share_premium and trg_enforce_aircraft_share_premium were
-- both BEFORE UPDATE. Setting share_token / share_code in the INSERT skipped
-- the gate entirely, so a non-Premium account could create an already-shared
-- folder or aircraft through a direct API call -- the identical write is
-- refused via PATCH and accepted via POST.
--
-- Same class as gotcha_tier_caps_create_time_only.md, inverted: there the cap
-- was checked only at create time, here the gate is checked only after it.
--
-- SCOPE OF THE ACTUAL EXPOSURE, checked before writing this: no paid CONTENT
-- was reachable. has_folder_access() and has_aircraft_access() both require
-- BOTH parties to be Premium, so a collaborator joining an illegitimate share
-- sees nothing. What leaked was the paid FEATURE itself -- the ability to mint
-- a working share link. Not reachable from the shipped app either
-- (sharedFolders.ts uses .update(), and share_token is not in the sync push
-- model), so this is an API-direct bypass.
--
-- Referencing OLD in an INSERT trigger raises 'record "old" is not assigned
-- yet', so the shared function has to branch on TG_OP rather than simply
-- widening the trigger.

begin;

create or replace function public.enforce_folder_share_premium()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  IF NEW.share_token IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.share_token IS DISTINCT FROM OLD.share_token) THEN
    IF NOT EXISTS (
      SELECT 1 FROM user_entitlements ue
      WHERE ue.user_id = NEW.user_id AND ue.is_premium = true
    ) THEN
      RAISE EXCEPTION 'Folder sharing requires Premium';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

drop trigger if exists trg_enforce_folder_share_premium on public.synced_folders;
create trigger trg_enforce_folder_share_premium
  before insert or update on public.synced_folders
  for each row execute function enforce_folder_share_premium();

create or replace function public.enforce_aircraft_share_premium()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  IF NEW.share_code IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.share_code IS DISTINCT FROM OLD.share_code) THEN
    IF NOT EXISTS (
      SELECT 1 FROM user_entitlements ue
      WHERE ue.user_id = NEW.user_id AND ue.is_premium = true
    ) THEN
      RAISE EXCEPTION 'Aircraft sharing requires Premium';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

drop trigger if exists trg_enforce_aircraft_share_premium on public.user_aircraft;
create trigger trg_enforce_aircraft_share_premium
  before insert or update on public.user_aircraft
  for each row execute function enforce_aircraft_share_premium();

commit;
