-- Aircraft photo upload -- Ryan (Suggest a feature, 2026-08-30, submission
-- 71a906b7): "allow users to upload an image of their aircraft into the my
-- aircraft or my fleet section... utilize the same code that we used in the
-- user profile avatars... show up in a larger pop-up window on screen...
-- when you actually open up the Aircraft page itself, we could probably put
-- that Aircraft image here."
--
-- Mirrors src/lib/avatar.ts's own storage shape exactly (a public bucket,
-- one object per owning row at <row id>/photo.jpg, upsert on re-upload) --
-- an aircraft photo carries no more sensitivity than a profile photo, and
-- viewer/editor collaborators on a shared aircraft already see everything
-- else about it, so there's no reason to gate this one field differently.
--
-- image_path stores the STORAGE OBJECT PATH, not a public URL -- the public
-- URL is derived client-side (getPublicUrl + a cache-busting query param on
-- every read, same as avatar.ts's own uploadAvatarAsset), so this column
-- never goes stale if the bucket's public base URL ever changes.

alter table public.user_aircraft
  add column if not exists image_path text;

insert into storage.buckets (id, name, public)
values ('aircraft-images', 'aircraft-images', true)
on conflict (id) do nothing;

-- SELECT: public, matching public_read_avatars -- aircraft photos need no
-- reader-side gate; anyone with the object's path (only ever handed out by
-- our own client code, and always for a photo the fleet/detail screen
-- already resolved via authorized SELECT on user_aircraft) can view it.
drop policy if exists public_read_aircraft_images on storage.objects;
create policy public_read_aircraft_images on storage.objects
  for select to public
  using (bucket_id = 'aircraft-images');

-- INSERT/UPDATE/DELETE: the object's path is always <aircraft_id>/photo.jpg
-- (storage.foldername(name))[1] is that aircraft's id) -- gate on the SAME
-- ownership-or-editor check user_aircraft's own RLS already enforces for
-- writing the row itself (has_aircraft_access, SECURITY DEFINER, already
-- backs editors_update_shared_aircraft). A read-only viewer collaborator
-- can never write a photo, same as they can never edit any other field.
drop policy if exists aircraft_owner_or_editor_upload_image on storage.objects;
create policy aircraft_owner_or_editor_upload_image on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'aircraft-images'
    and exists (
      select 1 from user_aircraft ua
      where ua.id::text = (storage.foldername(name))[1]
        and (ua.user_id = auth.uid() or has_aircraft_access(ua.id, true))
    )
  );

drop policy if exists aircraft_owner_or_editor_update_image on storage.objects;
create policy aircraft_owner_or_editor_update_image on storage.objects
  for update to authenticated
  using (
    bucket_id = 'aircraft-images'
    and exists (
      select 1 from user_aircraft ua
      where ua.id::text = (storage.foldername(name))[1]
        and (ua.user_id = auth.uid() or has_aircraft_access(ua.id, true))
    )
  );

drop policy if exists aircraft_owner_or_editor_delete_image on storage.objects;
create policy aircraft_owner_or_editor_delete_image on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'aircraft-images'
    and exists (
      select 1 from user_aircraft ua
      where ua.id::text = (storage.foldername(name))[1]
        and (ua.user_id = auth.uid() or has_aircraft_access(ua.id, true))
    )
  );

-- VERIFY AFTER APPLYING:
--  1. select id, image_path from user_aircraft limit 1; -- column exists, null
--  2. select id, public from storage.buckets where id = 'aircraft-images'; -- true
--  3. As the OWNER of a real aircraft: upload to <that aircraft's id>/photo.jpg
--     -- must succeed.
--  4. As an unrelated account: same upload -- must be denied (RLS).
--  5. As an accepted EDITOR collaborator on that aircraft: same upload --
--     must succeed. As a VIEWER (read-only) collaborator: must be denied.
