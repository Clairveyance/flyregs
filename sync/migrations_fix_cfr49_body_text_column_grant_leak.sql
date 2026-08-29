-- 2026-08-29, full-sweep pass 4 (Search/SmartSearch), background agent audit.
-- Live-confirmed exploitable with nothing but the public anon key baked into
-- the app bundle -- zero session, zero account, zero Plus subscription:
--   curl .../cfr49_sections?select=section_number,body_text&body_text=not.is.null&limit=1
--     -> full real regulatory text (49 CFR 1544.1, a TSA security-program
--        section), the exact content cfr49_sections_gated exists to redact
--        for a non-Plus reader.
--
-- Same bug shape as gotcha_rls_does_not_gate_columns.md and this project's
-- own migrations_fix_pdf_url_cached_column_grant_leak.sql: a correctly-
-- written gated VIEW (cfr49_sections_gated already does
-- `CASE WHEN has_plus_access() THEN body_text ELSE NULL END`, and
-- src/app/cfr49/[id].tsx already reads through it) proves nothing about the
-- RAW table underneath, which still carried a direct column-level SELECT
-- grant to anon/authenticated. Every sibling paid-content table
-- (advisory_circulars.pdf_text, legal_interpretations.body_text,
-- dictionary_terms.senses, airworthiness_directives.body_text) already has
-- this grant revoked -- confirmed live via information_schema.column_
-- privileges before writing this. CFR49 was the one type that never got it.
--
-- Root cause of the miss: an earlier audit (see flyregs_gotchas.md) grouped
-- cfr49_sections with far_sections/aim_paragraphs/pcg_terms as "correctly
-- open" raw-grant tables -- true for those three (FAR/AIM/P-CG are 100%
-- free), but CFR49 is the one content type in that group with a real Plus
-- gate on its body text, and the comparison didn't catch that difference.
--
-- search_vector denied alongside body_text, matching the advisory_circulars
-- precedent in migrations_fix_pdf_url_cached_column_grant_leak.sql -- it's a
-- tsvector derived directly from body_text and could leak most of the same
-- content via ts_headline/ranking queries even with body_text itself closed.
-- cfr49_sections_gated doesn't select search_vector at all, so nothing in
-- the app's real read path is affected either way.

DO $$
DECLARE
  denied text[] := ARRAY['body_text', 'search_vector'];
  cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'cfr49_sections'
     AND NOT (column_name = ANY(denied));

  EXECUTE format('REVOKE SELECT ON public.cfr49_sections FROM anon, authenticated');
  EXECUTE format('GRANT SELECT (%s) ON public.cfr49_sections TO anon, authenticated', cols);

  RAISE NOTICE 'cfr49_sections -> denied: %', denied;
END $$;

-- Same pass, lower-severity hardening: hybrid_search() has no internal tier
-- check of its own and was directly EXECUTE-able by anon/authenticated.
-- Currently NOT exploitable -- content_chunks has RLS enabled with zero
-- policies, confirmed live that a direct anon call returns 0 rows
-- regardless of the query -- but semantic-search (the only real caller)
-- always goes through the edge function with SUPABASE_SERVICE_ROLE_KEY, and
-- grep confirms no client code calls hybrid_search via supabase.rpc with the
-- normal anon/authenticated session. Revoking here is pure defense-in-depth:
-- a future migration adding any permissive RLS policy to content_chunks for
-- an unrelated feature would otherwise silently reopen this into the same
-- class of leak the section above just closed.
-- Postgres grants EXECUTE to PUBLIC by default at CREATE FUNCTION time, and
-- every role (including anon/authenticated) is implicitly a member of
-- PUBLIC -- revoking from the two named roles alone left PUBLIC's own grant
-- still in effect (confirmed live: role_routine_grants still showed PUBLIC
-- with EXECUTE after the anon/authenticated-only revoke below ran once).
-- Both revokes are needed; service_role/postgres are unaffected since
-- they're granted directly, not through PUBLIC.
revoke execute on function public.hybrid_search(vector, text, text[], integer) from public;
revoke execute on function public.hybrid_search(vector, text, text[], integer) from anon, authenticated;
