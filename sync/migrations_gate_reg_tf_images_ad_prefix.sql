-- Gate the AD page images in reg-tf-images (2026-08-31)
--
-- PROVEN LIVE, KEYLESS. Every Airworthiness Directive's full-page scans are
-- downloadable by anyone on the internet with NO apikey and NO Authorization
-- header at all:
--
--   GET /storage/v1/object/public/reg-tf-images/ad/2002-11-03/page-6.png
--   -> HTTP 200, 312482 bytes, PNG 1275x1650 (letter @150 DPI)
--
-- The page carries the AD's own compliance prose -- i.e. exactly the
-- body_text that airworthiness_directives_gated NULLs out below Plus. The
-- contrast is stark and was verified in the same minute:
--
--   ad_figures (rows)                        as anon -> []      (Plus gate OK)
--   airworthiness_directives_gated.body_text as anon -> null    (Plus gate OK)
--   the SAME content as a PNG, no credentials       -> HTTP 200 (gate bypassed)
--
-- Scope: 902 objects under ad/, covering 461 distinct ADs. Paths are fully
-- predictable as ad/{ad_number}/page-{n}.png from the freely-readable
-- airworthiness_directives.ad_number, and anon can also enumerate the whole
-- prefix via the storage list endpoint.
--
-- Root cause: the 2026-08-22 fix (migrations_fix_ad_figures_plus_gate.sql)
-- closed the ROW half only. migrations_gate_storage_buckets.sql had already
-- flipped four other buckets to private+signed but DELIBERATELY skipped this
-- one, because it mixes paid AD scans with FREE AIM/FAR/PCG figures under one
-- bucket, separated only by folder prefix -- and said so, leaving it for "its
-- own careful pass". This is that pass.
--
-- WHY public=false IS REQUIRED AND A POLICY ALONE IS NOT ENOUGH: while a
-- bucket is public, the /object/public/ route serves objects WITHOUT
-- consulting storage RLS at all. Tightening the policy while leaving the flag
-- set would change nothing for the actual exploit above.
--
-- SHIPPED-BUILD SAFETY (checked before writing this -- see
-- gotcha_rls_fix_broke_shipped_build.md, which this project has hit 3 times):
--   * B37 (commit c1e4d57) already contains src/lib/gatedStorage.ts and its
--     createSignedUrl path, and that file's own header notes createSignedUrl
--     does NOT require the bucket to be private -- so signing already works
--     today and keeps working after the flip.
--   * Every consumer of a reg-tf-images URL signs: FigureViewer.tsx and
--     FigureThumb.tsx via useGatedCachedImage -> resolveGatedStorageUrl,
--     printReg.ts via resolveGatedStorageUrl directly, ac/[id].tsx via
--     downloadGatedImageToCache. All three are present in B37.
--   * Grepped every image_url consumer in src/: none renders a raw public URL
--     in a bare <Image>; all flow through a signing path.
--   * FREE AIM/FAR/PCG figures keep unconditional read below -- they are
--     gated by prefix, not by the bucket flag, so nothing free becomes paid.

begin;

-- 1. Stop the unauthenticated /object/public/ route for this bucket.
update storage.buckets set public = false where id = 'reg-tf-images';

-- 2. Replace the blanket "anyone may read anything here" policy.
drop policy if exists public_read_reg_tf_images on storage.objects;

-- 3. Free content (aim/, far/, pcg/ prefixes) stays readable by anyone --
--    same access it has today, just now via a signed URL rather than the
--    public route. Deliberately expressed as "not ad" rather than an
--    allow-list of known free prefixes, so a NEW free corpus added later
--    doesn't silently become unreadable.
create policy public_read_reg_tf_images_free on storage.objects
  for select
  using (
    bucket_id = 'reg-tf-images'
    and (storage.foldername(name))[1] <> 'ad'
  );

-- 4. AD page scans require Plus, matching ad_figures' own row policy
--    (USING (has_plus_access())) so the row gate and the object gate finally
--    agree. has_plus_access() coalesces to false for a null auth.uid(), so
--    this fails closed for anon.
create policy gated_read_reg_tf_images_ad on storage.objects
  for select
  using (
    bucket_id = 'reg-tf-images'
    and (storage.foldername(name))[1] = 'ad'
    and public.has_plus_access()
  );

commit;

-- VERIFY AFTER APPLYING (all three must hold):
--   1. keyless GET of an ad/ page  -> 400/403, NOT 200
--   2. keyless GET of an aim/ page -> still works via signed URL in-app
--   3. a Plus account can still open an AD's pages in the app
