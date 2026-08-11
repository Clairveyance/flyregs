-- RC, 2026-08-11: "make sure any of the other issues or cleanups are taken
-- care of fully." The 2026-08-11 gating sweep closed the APP-FACING leak
-- (pdf_url_cached/image_url nulled in the gated views/RPCs for non-eligible
-- tiers) but left the underlying Storage buckets themselves public --
-- anyone with a saved or guessed object URL could fetch the PDF/image
-- bytes directly, no auth at all, completely bypassing the tier gate.
--
-- Scope: ac-figures (4230 rows, unique content we extracted ourselves --
-- highest real value here, no alternate public source exists for a
-- specific cropped figure/table image) and ac-formula-refs (4 rows, same
-- shape) are the two that matter most. advisory-circulars and
-- legal-interpretations (whole-PDF caches) are lower marginal risk in
-- practice -- confirmed live, every single row with a cached PDF ALSO has
-- an already-public alternate source column (pdf_url_faa / source_url,
-- both correctly ungated, pointing at faa.gov/govinfo.gov/DRS -- genuinely
-- public government records, not something FlyRegs controls access to) --
-- but gated anyway, for consistency with the tier model and because that
-- "always has an alternate" property isn't guaranteed to hold forever.
--
-- reg-tf-images (AD figures + free-tier AIM/FAR/PCG figures, sharing one
-- bucket by folder prefix) is DELIBERATELY NOT touched in this migration --
-- see PROJECT_NOTES/flyregs_pending.md's entry on this round for why it
-- needs its own careful pass (locking down its `ad/` prefix without also
-- locking out the free content sharing the same bucket).
--
-- Client side: buckets going private does NOT change what URL STRING the
-- scrapers write (they hardcode the /object/public/<bucket>/<path> pattern
-- regardless of the bucket's actual flag -- confirmed in loi_scraper.py/
-- faa_scraper.py, both authenticate with the service-role key, which
-- bypasses RLS entirely and is unaffected by anything here either way).
-- That string is now just a stable identifier, not a directly-fetchable
-- URL -- src/lib/gatedStorage.ts's resolveGatedStorageUrl() parses it and
-- mints a real, short-lived signed URL on demand, gated by exactly the
-- same RLS policies below (minting a signed URL still requires the
-- caller to pass the object's own SELECT policy).

UPDATE storage.buckets SET public = false
WHERE id IN ('ac-figures', 'ac-formula-refs', 'advisory-circulars', 'legal-interpretations');

-- ac-figures/ac-formula-refs already had an unconditional "public_read_*"
-- SELECT policy (unrelated to the bucket's own public flag -- Storage
-- checks both independently) that would otherwise keep granting anyone
-- read access even after the bucket itself goes private. Replaced with an
-- entitlement-gated one. advisory-circulars/legal-interpretations had NO
-- explicit SELECT policy at all (their public access came from the bucket
-- flag alone), so those two just need a new policy added, nothing to drop.
DROP POLICY IF EXISTS public_read_ac_figures ON storage.objects;
DROP POLICY IF EXISTS public_read_ac_formula_refs ON storage.objects;
DROP POLICY IF EXISTS gated_read_ac_figures ON storage.objects;
DROP POLICY IF EXISTS gated_read_ac_formula_refs ON storage.objects;
DROP POLICY IF EXISTS gated_read_advisory_circulars ON storage.objects;
DROP POLICY IF EXISTS gated_read_legal_interpretations ON storage.objects;

CREATE POLICY gated_read_ac_figures ON storage.objects
  FOR SELECT USING (bucket_id = 'ac-figures' AND public.has_plus_access());

CREATE POLICY gated_read_ac_formula_refs ON storage.objects
  FOR SELECT USING (bucket_id = 'ac-formula-refs' AND public.has_plus_access());

CREATE POLICY gated_read_advisory_circulars ON storage.objects
  FOR SELECT USING (bucket_id = 'advisory-circulars' AND public.has_plus_access());

CREATE POLICY gated_read_legal_interpretations ON storage.objects
  FOR SELECT USING (bucket_id = 'legal-interpretations' AND public.has_pro_access());
