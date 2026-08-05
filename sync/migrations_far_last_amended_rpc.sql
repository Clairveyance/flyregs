-- Batch writer for far_sections.last_amended (2026-08-05).
--
-- Why an RPC rather than a plain PostgREST upsert: an upsert POST has to
-- carry every NOT NULL column, so writing just two date fields would mean
-- round-tripping body_text for all 4,292 rows -- megabytes of payload to
-- set a date, and a real risk of clobbering content with whatever the
-- client happened to be holding. A PATCH can't do it either, since each
-- row needs a different value and PostgREST PATCHes one value across a
-- filter.
--
-- So: one call, one jsonb array, an UPDATE ... FROM (VALUES) join. It can
-- only ever touch these two columns, which also makes it safe to call from
-- the weekly scraper.

CREATE OR REPLACE FUNCTION public.set_far_last_amended(rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  n integer;
BEGIN
  UPDATE far_sections f
     SET last_amended = (r->>'last_amended')::date,
         last_amended_is_floor = coalesce((r->>'last_amended_is_floor')::boolean, false)
    FROM jsonb_array_elements(rows) r
   WHERE f.id = (r->>'id')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

-- Sync-pipeline only. The app never writes these; it only reads them
-- through far_sections / filter_documents.
REVOKE ALL ON FUNCTION public.set_far_last_amended(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_far_last_amended(jsonb) TO service_role;
