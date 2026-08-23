-- ============================================================================
-- Per-item (not per-subpart/series/chapter) knowledge-level classification
-- for FAR/AC/AIM -- 2026-08-22, RC-greenlit
-- ============================================================================
--
-- BACKGROUND: far_knowledge_levels/ac_knowledge_levels/aim_knowledge_levels
-- (see migrations_classification_current.sql) are pure CASE-statement rule
-- functions keyed on structural position -- FAR part+subpart, AC subject
-- series, AIM chapter. That's real, "coarse tagging" flagged repeatedly:
-- every section in FAR Part 91 Subpart B gets the SAME cert-level array
-- regardless of whether it's a basic VFR rule or an IFR Category II/III
-- approach requirement; AC has ZERO per-document granularity at all (every
-- AC in subject series 91 -- from a basic checklist AC to AC 91-84
-- "Fractional Ownership Programs" -- gets one blanket array); AIM has one
-- hand-carved chapter/paragraph exception (5-4) and nothing else.
--
-- The Part 91 Subpart I/K fix (migrations_fix_far91_subpart_knowledge_
-- levels.sql, 2026-08-12) proved the leak is real but only patched 2 of the
-- ~9 flagged subparts, and only at subpart granularity -- still coarser
-- than per-section. Live-confirmed remaining leaks before this migration:
-- FAR 91.167-91.193 (IFR fuel/cruising-altitude/CAT II-III rules) still
-- tagged down to 'student'; AC 91-84 (the AC-side mirror of the already-
-- fixed FAR Subpart K) still tagged down to 'student'; AIM 4-3-21ish
-- "Practice Instrument Approaches" paragraphs same shape.
--
-- THE FIX: real per-item classification (each FAR section / AC document /
-- AIM paragraph individually judged from its own text, by
-- scripts/classify_knowledge_levels.py -- an LLM batch pass CONSTRAINED so
-- it can only ever NARROW the existing coarse array, never widen it; see
-- that script's own header), written to three new tables mirroring the
-- existing pcg_term_levels/dictionary_term_levels shape. The three
-- '_all_levels' wrapper functions (the ones actually called by
-- get_study_pool_count/get_study_queue/create_challenge -- confirmed via
-- live prosrc search, the ONLY three callers of any of these functions)
-- now check the new table first, falling back to the original coarse
-- function for anything not yet classified (a freshly-synced section
-- before the next classification run, e.g.) -- so coverage gaps degrade to
-- the OLD safe-but-coarse behavior, never to "invisible to everyone."
--
-- far_all_levels/aim_all_levels needed ZERO call-site changes: both
-- already receive the per-item identifier (section_number /
-- paragraph_number) as a parameter, since far_ratings/aim_ratings already
-- needed it for the same reason. ac_all_levels did NOT previously receive
-- document_number -- this migration adds it as a required 2nd parameter
-- (old 1-arg signature dropped, not overloaded, so a stale call site would
-- fail loudly at deploy time rather than silently keep using the coarse
-- path) and updates its 5 live call sites (2 in get_study_queue, 2 in
-- create_challenge, 1 in get_study_pool_count).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- New tables -- same shape/grant/RLS pattern as pcg_term_levels and
-- dictionary_term_levels (RLS enabled, zero policies -- both existing
-- tables work today purely because every real caller goes through a
-- SECURITY DEFINER wrapper (get_study_pool_count/get_study_queue/
-- create_challenge are all SECURITY DEFINER), so RLS never actually
-- evaluates for authenticated users; SELECT is still granted to
-- anon/authenticated for consistency with the sibling tables even though
-- nothing exercises that direct path today).
-- ---------------------------------------------------------------------------
create table if not exists public.far_section_levels (
  section_number text primary key,
  levels text[] not null,
  model text,
  classified_at timestamptz not null default now()
);
alter table public.far_section_levels enable row level security;
grant select on public.far_section_levels to anon, authenticated;
grant select, insert, update, delete on public.far_section_levels to service_role, postgres;

create table if not exists public.ac_doc_levels (
  document_number text primary key,
  levels text[] not null,
  model text,
  classified_at timestamptz not null default now()
);
alter table public.ac_doc_levels enable row level security;
grant select on public.ac_doc_levels to anon, authenticated;
grant select, insert, update, delete on public.ac_doc_levels to service_role, postgres;

create table if not exists public.aim_paragraph_levels (
  paragraph_number text primary key,
  levels text[] not null,
  model text,
  classified_at timestamptz not null default now()
);
alter table public.aim_paragraph_levels enable row level security;
grant select on public.aim_paragraph_levels to anon, authenticated;
grant select, insert, update, delete on public.aim_paragraph_levels to service_role, postgres;

-- ---------------------------------------------------------------------------
-- far_all_levels: table-first, coarse-function fallback. Changed from
-- IMMUTABLE to STABLE since it now reads a table (was correct as IMMUTABLE
-- only while it was pure structural CASE logic).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.far_all_levels(p_part text, p_subpart_letter text, p_section_number text)
 RETURNS text[]
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    (select levels from far_section_levels where section_number = p_section_number),
    far_knowledge_levels(p_part, p_subpart_letter)
  ) || coalesce(far_ratings(p_part, p_section_number), '{}'::text[]);
$function$;

-- ---------------------------------------------------------------------------
-- aim_all_levels: same pattern, keyed on paragraph_number (already a
-- parameter -- no call-site changes needed anywhere).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aim_all_levels(p_chapter text, p_paragraph_number text)
 RETURNS text[]
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    (select levels from aim_paragraph_levels where paragraph_number = p_paragraph_number),
    aim_knowledge_levels(p_chapter, p_paragraph_number)
  ) || coalesce(aim_ratings(p_chapter, p_paragraph_number), '{}'::text[]);
$function$;

-- ---------------------------------------------------------------------------
-- ac_all_levels: SIGNATURE CHANGE -- gains p_document_number. Drop the old
-- 1-arg version outright (not overloaded) so a missed call site fails at
-- deploy/apply time instead of silently staying on the coarse-only path.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.ac_all_levels(text);

CREATE FUNCTION public.ac_all_levels(p_subject_series text, p_document_number text)
 RETURNS text[]
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    (select levels from ac_doc_levels where document_number = p_document_number),
    ac_knowledge_levels(p_subject_series)
  ) || coalesce(ac_ratings(p_subject_series), '{}'::text[]);
$function$;

GRANT EXECUTE ON FUNCTION public.ac_all_levels(text, text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The 5 live call sites for the old 1-arg ac_all_levels(subject_series).
-- Full bodies reproduced (pulled live via pg_get_functiondef immediately
-- before writing this file) -- only the ac_all_levels(...) call expressions
-- themselves changed from single-arg to (subject_series, document_number);
-- every other line is byte-identical to live.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_study_pool_count(p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[])
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT CASE WHEN NOT public.has_pro_access() THEN 0 ELSE
    (SELECT count(*) FROM pcg_terms p
       WHERE (p_item_types IS NULL OR 'pcg' = ANY(p_item_types))
         AND (p_levels IS NULL OR pcg_all_levels(p.slug, p.term) && p_levels)
         AND p.definition IS NOT NULL AND p.definition <> ''
         AND (p_category_classes IS NULL OR category_classes_from_text(p.term) IS NULL OR category_classes_from_text(p.term) && p_category_classes))
  + (SELECT count(*) FROM far_sections f
       WHERE (p_item_types IS NULL OR 'far' = ANY(p_item_types))
         AND f.body_text IS NOT NULL AND f.body_text <> ''
         AND f.title IS NOT NULL AND f.title <> ''
         AND f.section_number IN (SELECT section_number FROM study_far_sections)
         AND NOT (far_knowledge_levels(f.part, f.subpart_letter) && ARRAY['not_applicable'])
         AND (p_levels IS NULL OR far_all_levels(f.part, f.subpart_letter, f.section_number) && p_levels)
         AND (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes))
  + (SELECT count(*) FROM aim_paragraphs a
       WHERE (p_item_types IS NULL OR 'aim' = ANY(p_item_types))
         AND (p_levels IS NULL OR aim_all_levels(a.chapter, a.paragraph_number) && p_levels)
         AND a.body_text IS NOT NULL AND a.body_text <> ''
         AND (p_category_classes IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) && p_category_classes))
  + (SELECT count(*) FROM advisory_circulars c
       WHERE (p_item_types IS NULL OR 'ac' = ANY(p_item_types))
         AND c.status = 'active' AND c.description IS NOT NULL AND c.description <> ''
         AND c.title IS NOT NULL AND c.title <> ''
         AND NOT (ac_knowledge_levels(c.subject_series) && ARRAY['not_applicable'])
         AND (p_levels IS NULL OR ac_all_levels(c.subject_series, c.document_number) && p_levels)
         AND (p_category_classes IS NULL OR ac_category_classes(c.subject_series, c.title) IS NULL OR ac_category_classes(c.subject_series, c.title) && p_category_classes))
  + (SELECT count(*) FROM dictionary_terms d
       WHERE (p_item_types IS NULL OR 'dictionary' = ANY(p_item_types))
         AND d.category IN ('handbook', 'mnemonic')
         AND d.senses->0->>'definition' IS NOT NULL AND d.senses->0->>'definition' <> ''
         AND (p_levels IS NULL OR dictionary_all_levels(d.slug) && p_levels)
         AND (p_category_classes IS NULL OR dictionary_category_classes(d.slug) IS NULL OR dictionary_category_classes(d.slug) && p_category_classes))
  END;
$function$;

CREATE OR REPLACE FUNCTION public.get_study_queue(p_limit integer DEFAULT 20, p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[])
 RETURNS TABLE(item_id text, item_type text, term text, definition text, is_new boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH due AS (
    SELECT sp.item_id, sp.item_type,
      CASE sp.item_type
        WHEN 'pcg' THEN (SELECT p.term FROM pcg_terms p WHERE p.slug = sp.item_id)
        WHEN 'far' THEN (SELECT '§ ' || f.section_number || ' ' || regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') FROM far_sections f WHERE f.section_number = sp.item_id)
        WHEN 'aim' THEN (SELECT a.paragraph_number || COALESCE(' ' || a.title, '') FROM aim_paragraphs a WHERE a.paragraph_number = sp.item_id)
        WHEN 'ac' THEN (SELECT 'AC ' || c.document_number || ': ' || c.title FROM advisory_circulars c WHERE c.document_number = sp.item_id)
        WHEN 'dictionary' THEN (SELECT d.term FROM dictionary_terms d WHERE d.slug = sp.item_id)
      END AS term,
      CASE sp.item_type
        WHEN 'pcg' THEN (SELECT p.definition FROM pcg_terms p WHERE p.slug = sp.item_id)
        WHEN 'far' THEN (SELECT f.body_text FROM far_sections f WHERE f.section_number = sp.item_id)
        WHEN 'aim' THEN (SELECT a.body_text FROM aim_paragraphs a WHERE a.paragraph_number = sp.item_id)
        WHEN 'ac' THEN (SELECT c.title FROM advisory_circulars c WHERE c.document_number = sp.item_id)
        WHEN 'dictionary' THEN (SELECT d.senses->0->>'definition' FROM dictionary_terms d WHERE d.slug = sp.item_id)
      END AS definition,
      false AS is_new, extract(epoch FROM sp.next_review_at) AS sort_key
    FROM study_progress sp
    WHERE sp.user_id = auth.uid() AND sp.next_review_at <= now()
      AND (p_item_types IS NULL OR sp.item_type = ANY(p_item_types))
      AND (
        p_levels IS NULL
        OR (sp.item_type = 'aim' AND EXISTS (SELECT 1 FROM aim_paragraphs a4 WHERE a4.paragraph_number = sp.item_id AND aim_all_levels(a4.chapter, a4.paragraph_number) && p_levels))
        OR (sp.item_type = 'pcg' AND EXISTS (SELECT 1 FROM pcg_terms p4 WHERE p4.slug = sp.item_id AND pcg_all_levels(p4.slug, p4.term) && p_levels))
        OR (sp.item_type = 'far' AND EXISTS (
              SELECT 1 FROM far_sections f3 WHERE f3.section_number = sp.item_id
                AND far_all_levels(f3.part, f3.subpart_letter, f3.section_number) && p_levels
            ))
        OR (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c3 WHERE c3.document_number = sp.item_id
                AND ac_all_levels(c3.subject_series, c3.document_number) && p_levels
            ))
        OR (sp.item_type = 'dictionary' AND dictionary_all_levels(sp.item_id) && p_levels)
      )
      AND (
        NOT (sp.item_type = 'far' AND EXISTS (
              SELECT 1 FROM far_sections f3b WHERE f3b.section_number = sp.item_id
                AND far_knowledge_levels(f3b.part, f3b.subpart_letter) && ARRAY['not_applicable']
            ))
        AND NOT (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c3b WHERE c3b.document_number = sp.item_id
                AND ac_knowledge_levels(c3b.subject_series) && ARRAY['not_applicable']
            ))
      )
      AND (
        p_category_classes IS NULL
        OR (sp.item_type = 'pcg' AND EXISTS (
              SELECT 1 FROM pcg_terms p3 WHERE p3.slug = sp.item_id
                AND (category_classes_from_text(p3.term) IS NULL OR category_classes_from_text(p3.term) && p_category_classes)
            ))
        OR (sp.item_type = 'far' AND EXISTS (
              SELECT 1 FROM far_sections f4 WHERE f4.section_number = sp.item_id
                AND (far_category_classes(f4.part, f4.title) IS NULL OR far_category_classes(f4.part, f4.title) && p_category_classes)
            ))
        OR (sp.item_type = 'aim' AND EXISTS (
              SELECT 1 FROM aim_paragraphs a4b WHERE a4b.paragraph_number = sp.item_id
                AND (aim_category_classes(a4b.chapter, COALESCE(a4b.title, '')) IS NULL OR aim_category_classes(a4b.chapter, COALESCE(a4b.title, '')) && p_category_classes)
            ))
        OR (sp.item_type = 'ac' AND EXISTS (
              SELECT 1 FROM advisory_circulars c4 WHERE c4.document_number = sp.item_id
                AND (ac_category_classes(c4.subject_series, c4.title) IS NULL OR ac_category_classes(c4.subject_series, c4.title) && p_category_classes)
            ))
        OR (sp.item_type = 'dictionary' AND EXISTS (
              SELECT 1 FROM dictionary_terms d4 WHERE d4.slug = sp.item_id
                AND (dictionary_category_classes(d4.slug) IS NULL OR dictionary_category_classes(d4.slug) && p_category_classes)
            ))
      )
  ),
  fresh_pcg AS (
    SELECT p.slug AS item_id, 'pcg' AS item_type, p.term, p.definition, true AS is_new
    FROM pcg_terms p
    WHERE (p_item_types IS NULL OR 'pcg' = ANY(p_item_types))
      AND (p_levels IS NULL OR pcg_all_levels(p.slug, p.term) && p_levels)
      AND p.definition IS NOT NULL AND p.definition <> ''
      AND p.slug NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'pcg')
      AND (p_category_classes IS NULL OR category_classes_from_text(p.term) IS NULL OR category_classes_from_text(p.term) && p_category_classes)
    ORDER BY p.frequently_used DESC, random()
    LIMIT p_limit
  ),
  fresh_far AS (
    SELECT f.section_number AS item_id, 'far' AS item_type,
      '§ ' || f.section_number || ' ' || regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') AS term,
      f.body_text AS definition, true AS is_new
    FROM far_sections f
    WHERE (p_item_types IS NULL OR 'far' = ANY(p_item_types))
      AND f.body_text IS NOT NULL AND f.body_text <> ''
      AND f.title IS NOT NULL AND f.title <> ''
      AND f.section_number IN (SELECT section_number FROM study_far_sections)
      AND f.section_number NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'far')
      AND NOT (far_knowledge_levels(f.part, f.subpart_letter) && ARRAY['not_applicable'])
      AND (p_levels IS NULL OR far_all_levels(f.part, f.subpart_letter, f.section_number) && p_levels)
      AND (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes)
    ORDER BY (far_relevance_weight(f.part) + 1) * random() DESC
    LIMIT p_limit
  ),
  fresh_aim AS (
    SELECT a.paragraph_number AS item_id, 'aim' AS item_type,
      a.paragraph_number || COALESCE(' ' || a.title, '') AS term,
      a.body_text AS definition, true AS is_new
    FROM aim_paragraphs a
    WHERE (p_item_types IS NULL OR 'aim' = ANY(p_item_types))
      AND a.body_text IS NOT NULL AND a.body_text <> ''
      AND a.paragraph_number NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'aim')
      AND (p_levels IS NULL OR aim_all_levels(a.chapter, a.paragraph_number) && p_levels)
      AND (p_category_classes IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) && p_category_classes)
    ORDER BY random()
    LIMIT p_limit
  ),
  fresh_ac AS (
    SELECT c.document_number AS item_id, 'ac' AS item_type,
      'AC ' || c.document_number || ': ' || c.title AS term,
      c.title AS definition, true AS is_new
    FROM advisory_circulars c
    WHERE (p_item_types IS NULL OR 'ac' = ANY(p_item_types))
      AND c.status = 'active' AND c.description IS NOT NULL AND c.description <> ''
      AND c.title IS NOT NULL AND c.title <> ''
      -- The fix: only surface an AC as a "new" card once it has a real
      -- authored fact -- otherwise the client falls back to the bare
      -- title-as-question placeholder. See header comment.
      AND EXISTS (
            SELECT 1 FROM study_facts sf
            WHERE sf.item_type = 'ac' AND sf.item_id = c.document_number AND sf.status = 'live'
          )
      AND c.document_number NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'ac')
      AND NOT (ac_knowledge_levels(c.subject_series) && ARRAY['not_applicable'])
      AND (p_levels IS NULL OR ac_all_levels(c.subject_series, c.document_number) && p_levels)
      AND (p_category_classes IS NULL OR ac_category_classes(c.subject_series, c.title) IS NULL OR ac_category_classes(c.subject_series, c.title) && p_category_classes)
    ORDER BY (ac_relevance_weight(c.document_number) + 1) * random() DESC
    LIMIT p_limit
  ),
  fresh_dictionary AS (
    SELECT d.slug AS item_id, 'dictionary' AS item_type, d.term,
      d.senses->0->>'definition' AS definition, true AS is_new
    FROM dictionary_terms d
    WHERE (p_item_types IS NULL OR 'dictionary' = ANY(p_item_types))
      AND d.category IN ('handbook', 'mnemonic')
      AND d.senses->0->>'definition' IS NOT NULL AND d.senses->0->>'definition' <> ''
      AND (p_levels IS NULL OR dictionary_all_levels(d.slug) && p_levels)
      AND d.slug NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'dictionary')
      AND (p_category_classes IS NULL OR dictionary_category_classes(d.slug) IS NULL OR dictionary_category_classes(d.slug) && p_category_classes)
    -- RC specifically wants mnemonics studied ("a good thing to have
    -- people study") -- pure random() would drown the 52 mnemonics under
    -- 6,334 handbook terms (~0.8% odds each pull). This bias keeps real
    -- randomness within each bucket (not a deterministic top-N) while
    -- ensuring a mnemonic can actually win a slot instead of vanishing
    -- into the volume difference.
    ORDER BY (CASE WHEN d.category = 'mnemonic' THEN 1 ELSE 0 END) DESC, random()
    LIMIT p_limit
  ),
  fresh AS (
    SELECT * FROM fresh_pcg
    UNION ALL SELECT * FROM fresh_far
    UNION ALL SELECT * FROM fresh_aim
    UNION ALL SELECT * FROM fresh_ac
    UNION ALL SELECT * FROM fresh_dictionary
  ),
  combined AS (
    SELECT item_id, item_type, term, definition, is_new, 0 AS prio, sort_key FROM due
    WHERE term IS NOT NULL AND btrim(term) <> '' AND definition IS NOT NULL AND btrim(definition) <> ''
    UNION ALL
    SELECT item_id, item_type, term, definition, is_new, 1 AS prio, random() AS sort_key FROM fresh
  )
  SELECT item_id, item_type, term, definition, is_new FROM combined
  WHERE public.has_pro_access()
  ORDER BY prio, sort_key
  LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.create_challenge(p_opponent_ids uuid[], p_question_count integer DEFAULT 5, p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_challenge_id uuid;
  v_item record;
  v_fact record;
  v_have_fact boolean;
  v_i int := 0;
  v_choices text[];
  v_opp uuid;
  v_used_fact_ids uuid[] := array[]::uuid[];
  v_unavailable_callsigns text;
  v_non_premium_callsigns text;
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Duels requires Premium';
  end if;

  if array_length(p_opponent_ids, 1) is null or array_length(p_opponent_ids, 1) < 1 then
    raise exception 'At least one opponent required';
  end if;
  if array_length(p_opponent_ids, 1) > 7 then
    raise exception 'Duels support up to 8 total participants';
  end if;
  if auth.uid() = any(p_opponent_ids) then
    raise exception 'Cannot challenge yourself';
  end if;

  select string_agg(coalesce(cr.callsign, 'That pilot'), ', ')
  into v_unavailable_callsigns
  from unnest(p_opponent_ids) opp_id
  left join callsign_registry cr on cr.user_id = opp_id
  where not exists (
    select 1 from user_streaks us where us.user_id = opp_id and us.leaderboard_opt_in = true
  );
  if v_unavailable_callsigns is not null then
    raise exception '% hasn''t enabled Duel challenges yet. Remove them to continue.', v_unavailable_callsigns;
  end if;

  -- A non-Premium invitee can Decline (no tier check there) but can never
  -- Accept -- if they instead simply never respond, the duel would
  -- otherwise sit 'pending' for them forever, freezing everyone else's
  -- game since finalize_challenge_if_done requires zero pending
  -- participants. Reject at invite time instead of letting that happen.
  select string_agg(coalesce(cr.callsign, 'That pilot'), ', ')
  into v_non_premium_callsigns
  from unnest(p_opponent_ids) opp_id
  left join callsign_registry cr on cr.user_id = opp_id
  where not exists (
    select 1 from user_entitlements ue3 where ue3.user_id = opp_id and ue3.is_premium = true
  );
  if v_non_premium_callsigns is not null then
    raise exception '% isn''t on Premium, so they can''t be added to a Duel. Remove them to continue.', v_non_premium_callsigns;
  end if;

  insert into challenges (challenger_id, status, question_count, item_types, levels, category_classes)
  values (auth.uid(), 'active', p_question_count, p_item_types, p_levels, p_category_classes)
  returning id into v_challenge_id;

  insert into challenge_participants (challenge_id, user_id, is_creator, status, responded_at)
  values (v_challenge_id, auth.uid(), true, 'active', now());

  foreach v_opp in array p_opponent_ids loop
    insert into challenge_participants (challenge_id, user_id, is_creator, status)
    values (v_challenge_id, v_opp, false, 'pending')
    on conflict (challenge_id, user_id) do nothing;
  end loop;

  for v_item in
    select * from (
      select item_type, item_id from (
        select 'pcg' as item_type, term as item_id
        from quizzable_pcg_terms
        where (p_levels is null or pcg_all_levels(slug, term) && p_levels)
          and (p_category_classes is null or category_classes_from_text(term) is null or category_classes_from_text(term) && p_category_classes)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'pcg' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'far' as item_type, section_number as item_id
        from quizzable_far_sections f2
        where not (far_knowledge_levels(f2.part, f2.subpart_letter) && array['not_applicable'])
          and (p_levels is null or far_all_levels(f2.part, f2.subpart_letter, f2.section_number) && p_levels)
          and (p_category_classes is null or far_category_classes(f2.part, f2.title) is null or far_category_classes(f2.part, f2.title) && p_category_classes)
        order by (far_relevance_weight(f2.part) + 1) * random() desc limit p_question_count * 3
      ) x
      where p_item_types is null or 'far' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'aim' as item_type, paragraph_number as item_id
        from quizzable_aim_paragraphs
        where (p_levels is null or aim_all_levels(chapter, paragraph_number) && p_levels)
          and (p_category_classes is null or aim_category_classes(chapter, coalesce(title, '')) is null or aim_category_classes(chapter, coalesce(title, '')) && p_category_classes)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'aim' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'ac' as item_type, document_number as item_id
        from quizzable_advisory_circulars c2
        where not (ac_knowledge_levels(c2.subject_series) && array['not_applicable'])
          and (p_levels is null or ac_all_levels(c2.subject_series, c2.document_number) && p_levels)
          and (p_category_classes is null or ac_category_classes(c2.subject_series, c2.title) is null or ac_category_classes(c2.subject_series, c2.title) && p_category_classes)
        order by (ac_relevance_weight(c2.document_number) + 1) * random() desc limit p_question_count
      ) x
      where p_item_types is null or 'ac' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'dictionary' as item_type, slug as item_id
        from quizzable_dictionary_terms
        where (p_levels is null or dictionary_all_levels(slug) && p_levels)
          and (p_category_classes is null or dictionary_category_classes(slug) is null or dictionary_category_classes(slug) && p_category_classes)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'dictionary' = any(p_item_types)
    ) pool
    order by random() limit p_question_count
  loop
    v_have_fact := false;
    if v_item.item_type in ('far', 'aim', 'ac', 'dictionary') then
      select sf.* into v_fact
      from study_facts sf
      where sf.item_type = v_item.item_type
        and sf.item_id = v_item.item_id
        and sf.status = 'live'
        and sf.distractors is not null
        and array_length(sf.distractors, 1) = 3
        and not (sf.id = any(v_used_fact_ids))
      order by random()
      limit 1;
      v_have_fact := found;
    end if;

    if v_have_fact then
      v_used_fact_ids := array_append(v_used_fact_ids, v_fact.id);
      select array_agg(c order by random()) into v_choices
      from unnest(array_cat(array[v_fact.answer], v_fact.distractors)) c;

      insert into challenge_questions (challenge_id, sort_order, item_type, item_id, choices, fact_id, question, correct_answer)
      values (v_challenge_id, v_i, v_item.item_type, v_item.item_id, v_choices, v_fact.id, v_fact.question, v_fact.answer);
      v_i := v_i + 1;
      continue;
    end if;

    case v_item.item_type
      when 'pcg' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.term), array[]::text[]))
        into v_choices
        from (select term from pcg_terms where definition is not null and definition <> '' and term is not null and (p_levels is null or pcg_all_levels(slug, term) && p_levels) and term <> v_item.item_id order by random() limit 5) t;
      when 'far' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.section_number), array[]::text[]))
        into v_choices
        from (select section_number from far_sections f3 where f3.title is not null and f3.title <> ''
              and not (far_knowledge_levels(f3.part, f3.subpart_letter) && array['not_applicable'])
              and (p_levels is null or far_all_levels(f3.part, f3.subpart_letter, f3.section_number) && p_levels)
              and f3.section_number <> v_item.item_id order by random() limit 5) t;
      when 'aim' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.paragraph_number), array[]::text[]))
        into v_choices
        from (select paragraph_number from aim_paragraphs where title is not null and title <> '' and (p_levels is null or aim_all_levels(chapter, paragraph_number) && p_levels) and paragraph_number <> v_item.item_id order by random() limit 5) t;
      when 'ac' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.document_number), array[]::text[]))
        into v_choices
        from (select document_number from advisory_circulars c3 where c3.status = 'active' and c3.description is not null and c3.description <> '' and c3.title is not null and c3.title <> ''
              and not (ac_knowledge_levels(c3.subject_series) && array['not_applicable'])
              and (p_levels is null or ac_all_levels(c3.subject_series, c3.document_number) && p_levels)
              and c3.document_number <> v_item.item_id order by random() limit 5) t;
      when 'dictionary' then
        select array_cat(
          array[(select d.term from dictionary_terms d where d.slug = v_item.item_id)],
          coalesce(array_agg(t.term), array[]::text[])
        )
        into v_choices
        from (select term from quizzable_dictionary_terms
              where (p_levels is null or dictionary_all_levels(slug) && p_levels)
              and slug <> v_item.item_id order by random() limit 5) t;
    end case;

    select array_agg(c order by random()) into v_choices from unnest(v_choices) c;

    insert into challenge_questions (challenge_id, sort_order, item_type, item_id, choices)
    values (v_challenge_id, v_i, v_item.item_type, v_item.item_id, v_choices);
    v_i := v_i + 1;
  end loop;

  if v_i = 0 then
    raise exception 'No questions match those filters. Try widening the Content or Knowledge Level selection.';
  end if;

  if v_i <> p_question_count then
    update challenges set question_count = v_i where id = v_challenge_id;
  end if;

  return v_challenge_id;
end;
$function$;
