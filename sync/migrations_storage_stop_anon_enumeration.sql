-- The anon key can enumerate every user's avatar and every aircraft photo.
--
-- Found 2026-09-04 during the pre-wide-beta third-party/backend sweep.
-- `avatars` and `aircraft-images` are public buckets (deliberately -- both
-- render through getPublicUrl(), which is why they were never moved to
-- signed URLs with the other four). But each also carried a SELECT policy
-- granting the `public` role read on the WHOLE bucket:
--
--   public_read_avatars          SELECT {public}  bucket_id = 'avatars'
--   public_read_aircraft_images  SELECT {public}  bucket_id = 'aircraft-images'
--
-- Storage's list endpoint is a SELECT on storage.objects, so those policies
-- don't just permit reading a known object -- they permit ENUMERATING the
-- bucket. Reproduced live with nothing but the anon key (which ships inside
-- every copy of the app and is trivially extractable from the binary):
--
--   POST /storage/v1/object/list/avatars {"prefix":"","limit":100}
--   -> ["36c0c631-...", "37008a21-..."]   <- these are real user ids
--
-- That yields a complete roster of user ids plus every avatar and every
-- aircraft photo. Aircraft photos in particular routinely show a tail
-- number, and an N-number resolves through the public FAA registry to an
-- owner's name and address. Two users today; at wide beta it is the whole
-- user base.
--
-- The fix is NOT to make the buckets private. Verified first, before
-- changing anything, that /storage/v1/object/public/<bucket>/<path> serves
-- 200 with NO apikey header at all -- the public endpoint bypasses RLS
-- entirely, which is what "public bucket" means. So the app's rendering
-- path (avatar.ts:77 and aircraftImage.ts:45, both getPublicUrl()) does not
-- depend on these policies, and neither does imageCache.ts, which fetches
-- the same public URLs. Nothing in src/ calls .list() on either bucket.
--
-- What the policies ARE needed for is the row being visible to the
-- authenticated user who owns it: Postgres evaluates UPDATE/DELETE against
-- rows the statement can see, and this codebase has already been bitten by
-- exactly that (see gotcha_rls_delete_update_needs_select_visibility).
-- avatar.ts and aircraftImage.ts both call .remove() on replace and on
-- delete, so narrowing SELECT to nothing would break photo replacement.
--
-- So: keep SELECT, scoped to the same rows the existing UPDATE/DELETE
-- policies already scope to, for `authenticated` only. Own avatar for
-- avatars; owner-or-editor of the aircraft for aircraft-images -- mirroring
-- aircraft_owner_or_editor_delete_image exactly rather than inventing a
-- second, subtly different ownership test.
--
-- Net effect: everyone's photos still render for everyone, exactly as
-- before, through the public URL. Nobody can enumerate either bucket.

drop policy if exists public_read_avatars on storage.objects;
drop policy if exists public_read_aircraft_images on storage.objects;

create policy users_read_own_avatar on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );

create policy aircraft_owner_or_editor_read_image on storage.objects
  for select to authenticated
  using (
    bucket_id = 'aircraft-images'
    and exists (
      select 1 from user_aircraft ua
      where (ua.id)::text = (storage.foldername(objects.name))[1]
        and (ua.user_id = auth.uid() or has_aircraft_access(ua.id, true))
    )
  );
