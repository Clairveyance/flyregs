-- Fixes P0-2 from the 2026-08-22 gating audit: any upsert of an EXISTING,
-- already-in-cap folder (a rename, a reorder, or the full backup push)
-- was permanently failing for any Plus/Pro user sitting at or over their
-- folder cap -- not just on downgrade. Confirmed live: Pro account,
-- exactly 3 folders (the marketed max), renaming any one of them 400'd
-- with "Folder limit reached for your current plan."
--
-- Root cause: enforce_folder_cap() is a BEFORE INSERT trigger.
-- supabase.from('synced_folders').upsert(...) compiles to
-- INSERT ... ON CONFLICT (user_id, id) DO UPDATE, and Postgres fires
-- BEFORE INSERT triggers BEFORE resolving the ON CONFLICT clause -- so an
-- upsert of a row that already exists (a genuine update, not a new
-- folder) still ran the "count >= cap" check meant only for real growth,
-- and a user already at/over cap always failed it regardless of whether
-- the folder count was actually increasing.
--
-- Fix: if a row with this exact (user_id, id) already exists, this
-- upsert will resolve to an UPDATE, not a real new folder -- skip the cap
-- check entirely in that case (matches the intent: cap growth, not
-- edits to what's already there). The Pro-access check stays unconditional
-- for both inserts and updates, unchanged.
CREATE OR REPLACE FUNCTION public.enforce_folder_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_pro_access(NEW.user_id) THEN
    RAISE EXCEPTION 'Folders require Pro';
  END IF;
  IF EXISTS (SELECT 1 FROM synced_folders WHERE user_id = NEW.user_id AND id = NEW.id) THEN
    RETURN NEW;
  END IF;
  IF (SELECT count(*) FROM synced_folders WHERE user_id = NEW.user_id AND deleted = false) >= public.folder_visible_cap() THEN
    RAISE EXCEPTION 'Folder limit reached for your current plan';
  END IF;
  RETURN NEW;
END;
$function$;
