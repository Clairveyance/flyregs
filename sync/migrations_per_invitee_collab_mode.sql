-- BB-077: per-invitee read/write toggles. Previously access was folder-wide
-- only -- one collab_mode on synced_folders shared by every collaborator, so
-- an owner could not give one person write access and another read-only on
-- the same folder. Moves enforcement to a per-collaborator column while
-- keeping synced_folders.collab_mode as the DEFAULT applied to a NEW
-- collaborator at join time (matches prior behavior for anyone who hasn't
-- been individually customized).

ALTER TABLE public.folder_collaborators
  ADD COLUMN collab_mode text NOT NULL DEFAULT 'read_only'
    CHECK (collab_mode IN ('read_only', 'read_write'));

-- Backfill: every existing collaborator keeps exactly the access they have
-- today (the folder's current setting) -- this migration changes nothing
-- for anyone until the owner explicitly customizes a person.
UPDATE public.folder_collaborators fc
SET collab_mode = sf.collab_mode
FROM public.synced_folders sf
WHERE sf.id = fc.folder_id;

-- Enforcement moves from the folder-wide setting to the per-collaborator one.
CREATE OR REPLACE FUNCTION public.has_folder_access(p_folder_id text, p_require_editor boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from folder_collaborators fc
    where fc.folder_id = p_folder_id
      and fc.user_id = auth.uid()
      and fc.left_at is null
      and (not p_require_editor or fc.collab_mode = 'read_write')
  );
$function$;

-- New collaborators inherit the folder's current collab_mode as their
-- starting point, same as before this change -- the owner can still
-- customize any individual afterward.
CREATE OR REPLACE FUNCTION public.join_shared_folder(p_token text)
 RETURNS TABLE(out_folder_id text, out_folder_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_folder record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM user_entitlements ue WHERE ue.user_id = auth.uid() AND ue.is_premium = true) THEN
    RAISE EXCEPTION 'Folder sharing requires Premium';
  END IF;

  SELECT id, name, user_id, collab_mode INTO v_folder FROM synced_folders WHERE share_token = p_token AND deleted = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or expired invite link';
  END IF;
  IF v_folder.user_id = auth.uid() THEN
    RAISE EXCEPTION 'You already own this folder';
  END IF;
  INSERT INTO folder_collaborators (folder_id, owner_id, user_id, collab_mode)
  VALUES (v_folder.id, v_folder.user_id, auth.uid(), v_folder.collab_mode)
  ON CONFLICT (folder_id, user_id) DO UPDATE SET left_at = NULL;
  RETURN QUERY SELECT v_folder.id, v_folder.name;
END;
$function$;

-- Owner can now update an individual collaborator's mode directly -- no new
-- RPC needed, matches the existing pattern where owners already get
-- SELECT/DELETE on this table straight through RLS (see
-- owners_view_folder_collaborators / owners_remove_collaborators).
CREATE POLICY owners_update_collaborator_mode ON public.folder_collaborators
  FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- Surface each collaborator's own mode to the owner's roster UI (BB-077).
-- CREATE OR REPLACE, not a new function -- Postgres treats a changed return
-- signature as a new overload rather than replacing in place (see
-- gotcha_create_or_replace_signature_overload), so the old 5-column version
-- is dropped first.
DROP FUNCTION IF EXISTS public.get_folder_collaborators(text);

CREATE FUNCTION public.get_folder_collaborators(p_folder_id text)
 RETURNS TABLE(out_user_id uuid, out_display_label text, out_joined_at timestamp with time zone, out_left_at timestamp with time zone, out_last_viewed_at timestamp with time zone, out_collab_mode text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM synced_folders WHERE id = p_folder_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
    SELECT
      fc.user_id,
      COALESCE(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
      fc.joined_at,
      fc.left_at,
      fc.last_viewed_at,
      fc.collab_mode
    FROM folder_collaborators fc
    JOIN auth.users u ON u.id = fc.user_id
    LEFT JOIN callsign_registry cr ON cr.user_id = fc.user_id
    WHERE fc.folder_id = p_folder_id;
END;
$function$;
