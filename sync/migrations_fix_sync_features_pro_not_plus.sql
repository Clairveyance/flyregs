-- RC, 2026-08-11, direct correction: "back up sync is Pro. Any gating
-- needs to be fixed to make sure only Pro and Prem have any bu/s." Folders,
-- notes, bookmarks (which also covers highlights -- a highlight is just a
-- synced_bookmarks row with acId/blockText/blockKind set, same table, same
-- gate) are the app's actual "your data synced across devices" feature and
-- were all gated at Plus, both server and client -- corrected here to Pro.
-- Function names below keep their historical "_plus_gate" naming rather
-- than a rename-plus-trigger-recreation for a name-only change; the actual
-- check inside each is what matters and is now correct.

CREATE OR REPLACE FUNCTION public.enforce_bookmark_plus_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_pro_access(NEW.user_id) THEN
    RAISE EXCEPTION 'Bookmarks require Pro';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_note_plus_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_pro_access(NEW.user_id) THEN
    RAISE EXCEPTION 'Notes require Pro';
  END IF;
  RETURN NEW;
END;
$function$;

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
  IF (SELECT count(*) FROM synced_folders WHERE user_id = NEW.user_id AND deleted = false) >= public.folder_visible_cap() THEN
    RAISE EXCEPTION 'Folder limit reached for your current plan';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_folder_item_access()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
    EXISTS (SELECT 1 FROM synced_folders sf WHERE sf.id = NEW.folder_id AND sf.user_id = auth.uid() AND public.has_pro_access(sf.user_id))
    OR public.has_folder_access(NEW.folder_id, true)
  ) THEN
    RAISE EXCEPTION 'You do not have write access to this folder';
  END IF;
  RETURN NEW;
END;
$function$;
