-- avatars and aircraft-images accepted uploads of ANY size and ANY type.
--
-- Found alongside the enumeration leak, 2026-09-04. Both buckets had
-- file_size_limit = null and allowed_mime_types = null, and both are
-- public. So any signed-in account -- and signing up is free and instant --
-- could upload an arbitrarily large file of any type and get back a
-- permanent, unauthenticated public URL for it. Two problems in one:
-- unbounded storage cost, and FlyRegs unintentionally acting as public
-- file hosting for whatever someone chose to put there.
--
-- Sized against what the app actually stores, measured rather than
-- guessed. Every real object in both buckets today:
--
--   aircraft-images   3 objects   max 383 KB   all image/jpeg
--   avatars           2 objects   max 421 KB   all image/jpeg
--
-- avatar.ts and aircraftImage.ts both upload with contentType 'image/jpeg'
-- at quality 0.7 and no resize, so the ceiling is whatever the phone's
-- camera produces. 10 MB is ~24x the largest real object and still well
-- above a 48 MP JPEG, so no legitimate upload can hit it.
--
-- The mime list intentionally allows png/heic/webp as well as jpeg, matching
-- the list feedback-attachments has already run on without incident. The
-- clients only ever send image/jpeg today; the extra three cost nothing and
-- mean a future format change fails visibly at review rather than silently
-- at upload.

update storage.buckets
set file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/heic', 'image/webp']
where id in ('avatars', 'aircraft-images');
