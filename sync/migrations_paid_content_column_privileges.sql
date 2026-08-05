-- Make the tier gates real at the database level (2026-08-05).
--
-- FOUND during the pre-beta gating audit. The `*_gated` views were doing
-- their job, and every client call site had been switched to them -- but
-- the gates were still bypassable two different ways, both confirmed live
-- against production with nothing but the anon key that ships inside the
-- app bundle:
--
--   1. THE RAW TABLES WERE DIRECTLY READABLE. Every one of the four
--      content tables has RLS enabled but a `USING (true)` public-read
--      policy plus a table-level SELECT grant to anon/authenticated. RLS
--      filters ROWS, not COLUMNS, so "public read" meant every column,
--      including the ones the gated views exist to redact. Measured, as an
--      anonymous caller with no account:
--        advisory_circulars.pdf_blocks   -> 60 blocks of a paid AC
--        airworthiness_directives.body_text -> 8,644 chars
--        legal_interpretations.body_text -> 3,255 chars   (Pro-gated!)
--        dictionary_terms.senses         -> full mnemonic breakdowns
--
--   2. `pdf_text` LEAKED THROUGH THE GATED VIEW ITSELF. advisory_circulars
--      stores the same AC text TWICE -- structured in `pdf_blocks`, flat in
--      `pdf_text`. The view redacted only the first. Selecting `pdf_text`
--      from advisory_circulars_gated returned 18,928 characters of a paid
--      AC to an anonymous caller. Redacting one column of a two-column
--      copy is not a gate.
--
-- Column-level privileges are the right tool here, not more RLS: the gate
-- is per-COLUMN, and RLS cannot express that. The `*_gated` views keep
-- working untouched because they are `security_invoker = false` and owned
-- by postgres -- they read the base tables as the owner, so revoking from
-- anon/authenticated never reaches them.
--
-- Deliberately NOT revoked: every metadata column (document_number, title,
-- ad_number, slug, term, summary, applicability, ...). Browsing, searching
-- and citation lookup are free tiers of the product and must stay that way
-- -- this only removes the columns a paying customer is paying for.
--
-- `search_vector` IS revoked. A tsvector carries stemmed lexemes with
-- positions; enough of a document is reconstructable from one that handing
-- it out undoes the point of withholding the text. Nothing client-side
-- reads it -- all search runs through SECURITY DEFINER functions and the
-- hybrid_search Edge Function, which are unaffected.

-- ── 1. Plug the pdf_text hole in the AC gated view ───────────────────────
-- Same predicate as pdf_blocks. Free callers get the first ~2,000 chars,
-- which is roughly the two-block preview pdf_blocks already allows, rather
-- than NULL -- the free AC preview is a real product feature and reads
-- this column.
CREATE OR REPLACE VIEW public.advisory_circulars_gated AS
 SELECT id, document_number, title, date_issued, office, change_number,
        status, subject_series, description, document_id, cancels,
        pdf_url_faa, pdf_url_cached, pdf_size_bytes,
        CASE
            WHEN has_plus_access() THEN pdf_text
            ELSE left(pdf_text, 2000)
        END AS pdf_text,
        last_scraped_at, created_at, updated_at,
        CASE
            WHEN has_plus_access() THEN pdf_blocks
            ELSE jsonb_path_query_array(pdf_blocks, '$[0 to 1]'::jsonpath)
        END AS pdf_blocks,
        pdf_blocks_version,
        changed_block_indices,
        COALESCE(jsonb_array_length(pdf_blocks), 0) AS pdf_blocks_total_count
   FROM advisory_circulars;

-- ── 2. LOI search, without handing out the body ─────────────────────────
-- loi/index.tsx ran `.textSearch('body_text', ...)` against the RAW table.
-- It only ever SELECTED metadata, but Postgres requires SELECT on any
-- column named in a WHERE clause, so the revoke below would have broken
-- LOI search outright. Searching the full text is deliberately free ("find
-- an LOI free, read it on Pro") -- so the search moves server-side and
-- returns metadata only, the same shape as stale_highlight_ac_ids().
CREATE OR REPLACE FUNCTION public.search_legal_interpretations(
  q text,
  lim integer DEFAULT 50
)
 RETURNS TABLE(slug text, title text, addressee text, year integer,
               summary text, cfr_part_reference text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
  select l.slug, l.title, l.addressee, l.year, l.summary, l.cfr_part_reference
  from legal_interpretations l
  where q is null or btrim(q) = ''
     or to_tsvector('english', coalesce(l.body_text, '')) @@ plainto_tsquery('english', q)
     or l.title ilike '%' || q || '%'
  order by l.year desc nulls last, l.slug
  limit least(coalesce(lim, 50), 200);
$function$;

REVOKE ALL ON FUNCTION public.search_legal_interpretations(text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.search_legal_interpretations(text, integer) TO anon, authenticated;

-- ── 3. Column-level SELECT on the four content tables ───────────────────
-- Built from information_schema rather than hand-listed, so a column added
-- later is granted automatically and a typo can't silently drop access to
-- something the app needs. Re-run this block after adding any column.
DO $$
DECLARE
  t record;
  denied text[];
  cols text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'advisory_circulars',
      'airworthiness_directives',
      'legal_interpretations',
      'dictionary_terms'
    ]) AS tbl
  LOOP
    denied := CASE t.tbl
      WHEN 'advisory_circulars'       THEN ARRAY['pdf_blocks', 'pdf_text', 'search_vector']
      WHEN 'airworthiness_directives' THEN ARRAY['body_text', 'search_vector']
      WHEN 'legal_interpretations'    THEN ARRAY['body_text']
      WHEN 'dictionary_terms'         THEN ARRAY['senses', 'search_vector']
    END;

    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO cols
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = t.tbl
       AND NOT (column_name = ANY(denied));

    -- Table-level SELECT covers every column, including future ones, so it
    -- has to go before the column list can mean anything.
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', t.tbl);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO anon, authenticated', cols, t.tbl);

    RAISE NOTICE '% -> denied: %', t.tbl, denied;
  END LOOP;
END $$;
