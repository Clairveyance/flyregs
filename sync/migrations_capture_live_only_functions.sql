-- Eight functions that existed ONLY in the live database.
--
-- Captured 2026-09-18 by comparing every non-extension function in `public`
-- against every function any file in sync/ or migrations/ defines. Eight had no
-- definition anywhere on disk: they were created live via the Management API
-- and the matching .sql was never written back.
--
-- memory/gotcha_migration_files_drift_from_live_db.md documents exactly this
-- habit ("CREATE OR REPLACE FUNCTION makes it trivial to patch a live function
-- without ever touching disk") and warns not to trust a migration file as
-- matching what is deployed. What it did not cover is the other direction: a
-- function the repo has never heard of at all.
--
-- WHY THIS MATTERS MORE THAN TIDINESS. There is no point-in-time recovery on
-- this project, only daily snapshots (memory/supabase_backup_posture_no_pitr.md).
-- A snapshot would bring these back, but the repository -- the thing that is
-- actually reviewed, diffed and reasoned about -- did not describe the database
-- it deploys. expand_search_terms in particular is the query-expansion layer
-- underneath SmartSearch; nothing on disk said what it does.
--
-- These bodies are the LIVE definitions, captured verbatim via
-- pg_get_functiondef, not reconstructed. Applying this file is a no-op against
-- the current database by construction; it exists so the repo stops being
-- incomplete, and so a future reader can see these without querying production.
--
-- scripts/live_function_has_a_definition_audit.py fails if a ninth one appears.

begin;

-- ── ac_fts_vector ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ac_fts_vector(p_title text, p_doc_num text, p_description text, p_pdf_text text)
 RETURNS tsvector
 LANGUAGE sql
 IMMUTABLE
AS $function$
    select
        setweight(to_tsvector('english', coalesce(p_title,       '')), 'A') ||
        setweight(to_tsvector('english', coalesce(p_doc_num,     '')), 'A') ||
        setweight(to_tsvector('english', coalesce(p_description, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(p_pdf_text,    '')), 'C');
$function$;

-- ── count_aim_paragraphs_by_chapter ─────────────────────────────
CREATE OR REPLACE FUNCTION public.count_aim_paragraphs_by_chapter()
 RETURNS TABLE(chapter text, cnt bigint)
 LANGUAGE sql
 STABLE
AS $function$
  select chapter, count(*) as cnt from aim_paragraphs group by chapter;
$function$;

-- ── count_far_sections_by_part ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.count_far_sections_by_part()
 RETURNS TABLE(part text, cnt bigint)
 LANGUAGE sql
 STABLE
AS $function$
  select part, count(*) as cnt from far_sections group by part;
$function$;

-- ── count_pcg_terms_by_letter ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.count_pcg_terms_by_letter()
 RETURNS TABLE(letter text, cnt bigint)
 LANGUAGE sql
 STABLE
AS $function$
  select letter, count(*) as cnt from pcg_terms group by letter;
$function$;

-- ── expand_search_terms ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.expand_search_terms(p_terms text[], p_limit integer DEFAULT 12)
 RETURNS TABLE(related text, score real)
 LANGUAGE sql
 STABLE
AS $function$
  WITH input AS (
    SELECT DISTINCT lower(trim(t)) AS t FROM unnest(p_terms) AS t
    WHERE length(trim(t)) >= 3
  ),
  -- Distributional associations: words used in the same regulatory contexts.
  assoc AS (
    SELECT a.related, a.score
    FROM search_term_associations a
    JOIN input i ON a.term = i.t
  ),
  -- Morphological expansion: real corpus terms that START with the query
  -- ("ice" -> "icing"). Scored below associations on purpose -- a shared
  -- prefix is a weaker signal of relatedness than shared usage, so these
  -- should never outrank a true distributional match. Ordered by doc_freq
  -- so a common real term beats an obscure one.
  prefix AS (
    SELECT v.term AS related, (0.30 - (row_number() OVER (ORDER BY v.doc_freq DESC))::real * 0.005) AS score
    FROM search_vocabulary v
    JOIN input i ON v.term LIKE i.t || '%' AND v.term <> i.t
    WHERE length(v.term) > 3
    LIMIT 8
  ),
  merged AS (
    SELECT related, max(score) AS score FROM (
      SELECT * FROM assoc UNION ALL SELECT * FROM prefix
    ) u
    WHERE related NOT IN (SELECT t FROM input)
    GROUP BY related
  )
  SELECT related, score FROM merged ORDER BY score DESC LIMIT p_limit;
$function$;

-- ── get_my_coins ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_coins()
 RETURNS TABLE(coin_code text, earned_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coin_code, earned_at FROM user_coins WHERE user_id = auth.uid() ORDER BY earned_at;
$function$;

-- ── rls_auto_enable ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- ── set_updated_at ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
    new.updated_at = now();
    return new;
end;
$function$;

commit;
