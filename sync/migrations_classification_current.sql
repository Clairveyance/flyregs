-- ============================================================================
-- Study/Duels classification functions: CURRENT STATE SNAPSHOT, 2026-08-04
-- ============================================================================
--
-- WHAT THIS FILE IS FOR: RC asked directly "what's the fix for the on-disk
-- migration drift, and what problems is it causing?" The problem, found
-- twice in one day in two unrelated subsystems (see
-- gotcha_migration_files_drift_from_live_db and, for the DB-function
-- side specifically, this one): several classification functions were
-- hand-edited live via the Management API over time and the matching
-- .sql file was never recommitted. Concretely, BOTH
-- migrations_curriculum.sql AND migrations_far_category_callers.sql
-- contain STALE bodies for far_knowledge_levels, ac_knowledge_levels,
-- get_study_pool_count, get_study_queue, and create_challenge --
-- specifically:
--   - aim_knowledge_levels gained a second parameter (p_paragraph_number)
--     live, for the AIM 5-4 granularity fix -- the 1-arg version in both
--     older files no longer exists in the database at all.
--   - far_knowledge_levels/ac_knowledge_levels's ELSE branch changed live
--     from `NULL` to `ARRAY[]::text[]` -- functionally equivalent today
--     (both fail the `&&` overlap check the same way) but a real
--     discrepancy from what's on disk.
--   - get_study_pool_count/get_study_queue gained a `study_far_sections`
--     allowlist join on the FAR branch, live, never captured anywhere.
--
-- REAL problems this caused, not just hygiene: (1) wasted investigation
-- time -- reading the stale files produced wrong conclusions that had to
-- be re-verified against live state before they could be trusted; (2) a
-- real disaster-recovery risk -- if this project's DB were ever rebuilt
-- from the committed migration files alone, the OLD versions would
-- silently reintroduce the AIM 5-4 bug and lose the study_far_sections
-- scoping, with no error to reveal it. NOT a problem for the live app
-- today -- the live database already has the correct, current version of
-- everything; the gap was purely in the files-as-documentation layer.
--
-- THE FIX: this file. It is the current, complete, verified-against-live
-- (via pg_get_functiondef, immediately before writing this) state of
-- every classification function as of 2026-08-04. Treat THIS file, not
-- migrations_curriculum.sql or migrations_far_category_callers.sql, as
-- the starting point for any future change to these functions -- short
-- pointer comments have been added to the top of both older files
-- pointing here. Per this project's own "preserve history" convention,
-- the older files are NOT deleted or rewritten -- they stay as an
-- accurate record of what was believed true and why at the time, exactly
-- as this file itself will become historical the next time one of these
-- functions changes again. When that happens: pull pg_get_functiondef
-- live first (not this file), make the change, and write a NEW
-- current-state file the same way -- don't edit this one in place.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.category_classes_from_text(p_text text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT NULLIF(ARRAY_REMOVE(ARRAY[
    CASE WHEN p_text ~* '(single.?engine sea|single engine sea)' THEN 'ASES' END,
    CASE WHEN p_text ~* '(single.?engine land|single engine land)' THEN 'ASEL' END,
    CASE WHEN p_text ~* '(multi.?engine sea|multi engine sea)' THEN 'AMES' END,
    CASE WHEN p_text ~* '(multi.?engine land|multi engine land)' THEN 'AMEL' END,
    CASE WHEN p_text ~* 'helicopter' THEN 'HELI' END,
    CASE WHEN p_text ~* 'gyroplane' THEN 'GYRO' END,
    CASE WHEN p_text ~* 'glider' THEN 'GLIDER' END,
    CASE WHEN p_text ~* 'airship' THEN 'AIRSHIP' END,
    CASE WHEN p_text ~* 'balloon' THEN 'BALLOON' END,
    CASE WHEN p_text ~* '(powered.?lift)' THEN 'POWLIFT' END
  ], NULL), ARRAY[]::text[]);
$function$;

CREATE OR REPLACE FUNCTION public.pcg_knowledge_levels(p_slug text)
 RETURNS text[]
 LANGUAGE sql
 STABLE
AS $function$
  SELECT coalesce((SELECT levels FROM pcg_term_levels WHERE slug = p_slug), ARRAY[]::text[]);
$function$;

CREATE OR REPLACE FUNCTION public.far_knowledge_levels(p_part text, p_subpart text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_part = '61' AND p_subpart IN ('A','B','C','J')
      THEN ARRAY['student','private','commercial','atp','cfi']
    WHEN p_part = '61' AND p_subpart IN ('D','E')
      THEN ARRAY['private','commercial','atp','cfi']
    WHEN p_part = '61' AND p_subpart = 'F'
      THEN ARRAY['commercial','atp','cfi']
    WHEN p_part = '61' AND p_subpart = 'G'
      THEN ARRAY['atp']
    WHEN p_part = '61' AND p_subpart IN ('H','I','K')
      THEN ARRAY['cfi']
    WHEN p_part = '61'
      THEN ARRAY['student','private','commercial','atp','cfi']
    WHEN p_part = '91'
      THEN ARRAY['student','private','commercial','atp','cfi','mechanic']
    WHEN p_part IN ('71','73')
      THEN ARRAY['student','private','commercial','atp','cfi']
    WHEN p_part IN ('43','45','47','39')
      THEN ARRAY['student','private','commercial','atp','cfi','mechanic']
    WHEN p_part = '119' THEN ARRAY['commercial','atp','cfi']
    WHEN p_part IN ('117','121','125','135','136') THEN ARRAY['atp']
    WHEN p_part IN ('141','142') THEN ARRAY['cfi']
    WHEN p_part IN ('21','23','25','27','29','31','33','34','35','36','65','145','147','183')
      THEN ARRAY['mechanic']
    ELSE ARRAY[]::text[]
  END;
$function$;

CREATE OR REPLACE FUNCTION public.aim_knowledge_levels(p_chapter text, p_paragraph_number text DEFAULT NULL::text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_chapter = '5' AND p_paragraph_number LIKE '5-4-%'
      THEN ARRAY['private','commercial','atp','cfi']
    WHEN p_chapter IN ('1','2','3','4','5','6','7','8','9')
      THEN ARRAY['student','private','commercial','atp','cfi']
    WHEN p_chapter = '10' THEN ARRAY['commercial','atp','cfi']
    WHEN p_chapter = '11' THEN ARRAY['commercial','atp','cfi']
    ELSE ARRAY[]::text[]
  END;
$function$;

CREATE OR REPLACE FUNCTION public.ac_knowledge_levels(p_series text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_series IN ('00','60','61','67','70','90','91')
      THEN ARRAY['student','private','commercial','atp','cfi']
    WHEN p_series IN ('117','119','120','121','125','135')
      THEN ARRAY['atp']
    WHEN p_series IN ('140','141','142')
      THEN ARRAY['cfi']
    WHEN p_series IN ('20','21','23','25','27','29','33','35','36','39','43','45','65','147','183')
      THEN ARRAY['mechanic']
    ELSE ARRAY[]::text[]
  END;
$function$;

CREATE OR REPLACE FUNCTION public.far_category_classes(p_part text, p_title text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(
    array(
      select distinct cc from unnest(
        coalesce(category_classes_from_text(p_title), array[]::text[])
        || case p_part
             when '23' then array['ASEL','ASES','AMEL','AMES']
             when '25' then array['AMEL','AMES']
             when '27' then array['HELI','GYRO']
             when '29' then array['HELI','GYRO']
             when '31' then array['BALLOON']
             else array[]::text[]
           end
      ) as cc
      order by cc
    ),
    array[]::text[]
  );
$function$;

-- aim_category_classes and ac_category_classes: see
-- migrations_aim_category.sql and migrations_ac_category.sql respectively
-- (both new this same day -- not yet stale, no need to reproduce here).

-- study_far_sections: a curated allowlist table (3,628 rows as of
-- 2026-08-04, of 4,187 total FAR sections with body text) referenced by
-- get_study_pool_count and get_study_queue's fresh_far branch to exclude
-- administrative/boilerplate sections from the study pool. Structure/
-- population script not captured here -- flagged as a further gap if this
-- table's own definition is ever needed and not already committed
-- elsewhere; out of scope for this classification-functions sync.
