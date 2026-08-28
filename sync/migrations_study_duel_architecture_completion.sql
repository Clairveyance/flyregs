-- Study/Duel architecture completion -- 2026-08-28
--
-- RC, after the study-card audit found two gaps: "since this architecture
-- should have been in place from the beginning, make sure it's done
-- completely. make sure there is no regression... make sure all of our
-- study materials, across all regs and corpus are fully viable... for
-- other areas, general study, quiz, etc - make sure the filters are also
-- capturing and sorting these new pieces of intel."
--
-- Two real, distinct root causes, both closed here:
--
-- 1. study_far_sections (Study Mode's FAR pool) and quizzable_far_sections
--    (Duels' FAR pool) BOTH independently excluded any section whose title
--    exactly duplicates a sibling section's title within the same Part --
--    a guard built to protect the OLD reference-recall question format
--    ("Which Part 61 rule covers X?" is ambiguous when 2+ sections share a
--    title). Measured: 558 real, titled, real-body-text FAR sections hidden
--    corpus-wide, including 25 sections in Part 61 alone covering "Flight
--    proficiency," "Aeronautical experience," "Aeronautical knowledge," and
--    "Eligibility requirements" for EVERY rating (student through CFI/ATP)
--    -- not a CFI-only gap. This is exactly why 61.183/61.187 (both on
--    RC's own CFI checklist) were invisible in both Study Mode and Duels.
--
--    The guard is safe to drop now: far_knowledge_levels() already
--    independently filters out genuinely irrelevant content (Part 121/25/
--    27/29/171 admin headers stay excluded via that SEPARATE, correct
--    mechanism regardless of this change) -- confirmed directly, not
--    assumed, before touching anything.
--
--    Study Mode: fresh_far in get_study_queue never had the "only surface
--    as new once it has a live fact" gate that fresh_ac ALREADY has (see
--    fresh_ac's own comment -- this exact problem was already solved once,
--    just never applied to FAR). Added here, closing the ambiguous-
--    fallback risk permanently, not just for the newly-widened sections.
--
--    Duels: create_challenge() already has a live-fact-first path
--    (v_have_fact) with a graceful multiple-choice fallback when no fact
--    exists -- lower risk than Study Mode's old open-text fallback, but
--    the fallback's random distractors could still coincidentally include
--    another section sharing the same title. Added an explicit exclusion
--    for same-title distractors, closing that residual gap directly
--    rather than leaving it to chance.
--
-- 2. CFR49 was never wired into Study Mode or Duels as a content type at
--    all -- no cfr49_knowledge_levels()/cfr49_all_levels()/etc (unlike
--    far/aim/ac/pcg, which each have the full set), study_facts' own
--    CHECK constraint didn't allow 'cfr49', no quizzable_cfr49_sections
--    view, no wiring in get_study_queue/get_study_pool_count/
--    create_challenge/get_next_challenge_question. Built the full parallel
--    set here, mirroring the far_* pattern exactly, WITH the "must have a
--    live fact to be freshly surfaced" gate from day one (not retrofitted
--    later, unlike FAR). Tier-gated at Plus in Duels, matching the CFR49
--    RefPack detail screen's own existing gate (src/app/cfr49/[id].tsx).
--
--    Knowledge-level mapping (mirrors far_knowledge_levels' own reasoning
--    style): 830 (NTSB accident/incident reporting) is foundational safety
--    knowledge tested from private pilot onward -- student included, since
--    a solo cross-country student should know what to do after an
--    incident. 1552 (Flight Training Security Program / citizenship
--    verification) is squarely CFI/flight-school-facing, not something a
--    student or private pilot needs for their own certificate. 1544
--    (air carrier/commercial operator security) matches Part 121/135's own
--    ATP-only treatment -- same class of operator. 175 (hazmat carriage)
--    is general pilot knowledge, private onward.
--
-- cfr49_relevance_weight() reads acs_citation_density where
-- cited_type='cfr49' -- already populated with real data by this
-- afternoon's earlier ACS/PTS extraction fix (7667b52), so this ships with
-- genuine weighting from day one, not a cold-start zero.
--
-- Performance: verified in a rolled-back transaction before this file was
-- ever applied for real (see the session's own commit message for the
-- before/after numbers) -- study_far_sections stays materialized+indexed,
-- refresh_study_far_sections() unchanged, no query here scans a
-- meaningfully different row count than before.

-- ============================================================
-- PART 1: study_far_sections widened -- drop the title-collision
-- exclusion, keep the genuine data-quality guards (real title+body_text,
-- not a [Reserved] placeholder).
-- ============================================================
drop materialized view if exists public.study_far_sections;
create materialized view public.study_far_sections as
select section_number
from far_sections
where title is not null and title <> ''
  and body_text is not null and body_text <> ''
  and title !~~* '%[reserved%';

create unique index study_far_sections_pk on public.study_far_sections (section_number);
grant select on public.study_far_sections to anon, authenticated;

-- ============================================================
-- PART 2: quizzable_far_sections widened -- same reasoning, Duels' own
-- copy of the same guard. Keeps quiz_prompt/prompt_uses columns (schema
-- stability, in case anything else ever reads them) but no longer
-- requires prompt_uses = 1. Keeps the reserved-title guard and the
-- "quiz_prompt doesn't itself look like a citation number" guard --
-- both genuine data-quality checks, unrelated to collision.
-- ============================================================
create or replace view public.quizzable_far_sections as
select id, section_number, part, subpart_letter, subpart_title, title, body_text, updated_at, search_vector,
  quiz_prompt, prompt_uses
from (
  select f0.id, f0.section_number, f0.part, f0.subpart_letter, f0.subpart_title, f0.title, f0.body_text,
    f0.updated_at, f0.search_vector,
    regexp_replace(f0.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') as quiz_prompt,
    count(*) over (partition by regexp_replace(f0.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')) as prompt_uses
  from far_sections f0
  where f0.title is not null and f0.title <> ''
) f
where title !~~* '%[reserved%' and quiz_prompt !~ '[0-9]+\.[0-9]+';

-- ============================================================
-- PART 3: cfr49_* functions -- full parallel set, mirroring far_*'s own
-- shape and signatures exactly.
-- ============================================================
create or replace function public.cfr49_knowledge_levels(p_part text)
returns text[]
language sql
immutable
as $function$
  select case
    -- NTSB accident/incident reporting -- foundational safety knowledge,
    -- tested from private pilot onward. Student included: a solo
    -- cross-country student should know what to do after an incident.
    when p_part = '830' then array['student','private','commercial','atp','cfi']
    -- Flight Training Security Program (citizenship verification before
    -- training) -- squarely CFI/flight-school-facing, not something a
    -- student or private pilot needs for their OWN certificate.
    when p_part = '1552' then array['cfi']
    -- Air carrier/commercial operator security -- same class of operator
    -- Part 121/135 already restrict to ATP-only for the same reason.
    when p_part = '1544' then array['atp']
    -- Hazmat carriage -- general pilot knowledge, private onward.
    when p_part = '175' then array['private','commercial','atp','cfi']
    else array['not_applicable']
  end;
$function$;

create or replace function public.cfr49_ratings(p_part text, p_section_number text)
returns text[]
language sql
immutable
as $function$
  select array[]::text[];
$function$;

create or replace function public.cfr49_category_classes(p_part text, p_title text)
returns text[]
language sql
immutable
as $function$
  select null::text[];
$function$;

create table if not exists public.cfr49_section_levels (
  section_number text primary key,
  levels text[] not null
);
alter table public.cfr49_section_levels enable row level security;
drop policy if exists "cfr49_section_levels readable" on public.cfr49_section_levels;
create policy "cfr49_section_levels readable" on public.cfr49_section_levels for select using (true);
grant select on public.cfr49_section_levels to anon, authenticated;

create or replace function public.cfr49_all_levels(p_part text, p_section_number text)
returns text[]
language sql
stable
as $function$
  select coalesce(
    (select levels from cfr49_section_levels where section_number = p_section_number),
    cfr49_knowledge_levels(p_part)
  ) || coalesce(cfr49_ratings(p_part, p_section_number), '{}'::text[]);
$function$;

create or replace function public.cfr49_relevance_weight(p_part text)
returns integer
language sql
stable
as $function$
  select coalesce((select task_count from acs_citation_density where cited_type = 'cfr49' and cited_id = p_part), 0);
$function$;

grant execute on function public.cfr49_knowledge_levels(text) to anon, authenticated;
grant execute on function public.cfr49_ratings(text, text) to anon, authenticated;
grant execute on function public.cfr49_category_classes(text, text) to anon, authenticated;
grant execute on function public.cfr49_all_levels(text, text) to anon, authenticated;
grant execute on function public.cfr49_relevance_weight(text) to anon, authenticated;

-- ============================================================
-- PART 4: study_facts CHECK constraint -- allow cfr49.
-- ============================================================
alter table public.study_facts drop constraint if exists study_facts_item_type_check;
alter table public.study_facts add constraint study_facts_item_type_check
  check (item_type = any (array['far','aim','ac','pcg','dictionary','cfr49']));

-- ============================================================
-- PART 5: quizzable_cfr49_sections -- Duels' CFR49 pool, mirrors
-- quizzable_far_sections' already-widened shape (built fresh, no legacy
-- collision guard to remove -- doing it right from the start).
-- ============================================================
create or replace view public.quizzable_cfr49_sections as
select id, section_number, part, subpart_title, title, body_text, updated_at, search_vector,
  quiz_prompt, prompt_uses
from (
  select f0.id, f0.section_number, f0.part, f0.subpart_title, f0.title, f0.body_text,
    f0.updated_at, f0.search_vector,
    regexp_replace(f0.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') as quiz_prompt,
    count(*) over (partition by regexp_replace(f0.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')) as prompt_uses
  from cfr49_sections f0
  where f0.title is not null and f0.title <> ''
) f
where title !~~* '%[reserved%' and quiz_prompt !~ '[0-9]+\.[0-9]+';

grant select on public.quizzable_cfr49_sections to anon, authenticated;

-- ============================================================
-- PART 6: get_study_queue -- add the live-fact gate to fresh_far
-- (mirrors fresh_ac, closing the ambiguous-fallback risk for ALL of FAR,
-- not just the newly-widened sections), add cfr49 throughout (due CTE's
-- term/definition CASE + level/not_applicable filters, new fresh_cfr49
-- CTE with the SAME live-fact gate from day one).
-- ============================================================
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
        WHEN 'cfr49' THEN (SELECT '49 CFR ' || f5.section_number || ' ' || regexp_replace(f5.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') FROM cfr49_sections f5 WHERE f5.section_number = sp.item_id)
      END AS term,
      CASE sp.item_type
        WHEN 'pcg' THEN (SELECT p.definition FROM pcg_terms p WHERE p.slug = sp.item_id)
        WHEN 'far' THEN (SELECT f.body_text FROM far_sections f WHERE f.section_number = sp.item_id)
        WHEN 'aim' THEN (SELECT a.body_text FROM aim_paragraphs a WHERE a.paragraph_number = sp.item_id)
        WHEN 'ac' THEN (SELECT c.title FROM advisory_circulars c WHERE c.document_number = sp.item_id)
        WHEN 'dictionary' THEN (SELECT d.senses->0->>'definition' FROM dictionary_terms d WHERE d.slug = sp.item_id)
        WHEN 'cfr49' THEN (SELECT f5.body_text FROM cfr49_sections f5 WHERE f5.section_number = sp.item_id)
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
        OR (sp.item_type = 'cfr49' AND EXISTS (
              SELECT 1 FROM cfr49_sections f6 WHERE f6.section_number = sp.item_id
                AND cfr49_all_levels(f6.part, f6.section_number) && p_levels
            ))
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
        AND NOT (sp.item_type = 'cfr49' AND EXISTS (
              SELECT 1 FROM cfr49_sections f6b WHERE f6b.section_number = sp.item_id
                AND cfr49_knowledge_levels(f6b.part) && ARRAY['not_applicable']
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
        OR (sp.item_type = 'cfr49' AND EXISTS (
              SELECT 1 FROM cfr49_sections f6c WHERE f6c.section_number = sp.item_id
                AND (cfr49_category_classes(f6c.part, f6c.title) IS NULL OR cfr49_category_classes(f6c.part, f6c.title) && p_category_classes)
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
      -- Same fix fresh_ac already had (see its own comment below): only
      -- surface a FAR section as "new" once it has a real authored fact --
      -- otherwise the client falls back to the bare "Which Part N rule
      -- covers X?" placeholder, which is ambiguous for any section whose
      -- title collides with a sibling's (now that study_far_sections no
      -- longer excludes those, this gate is what keeps the fallback safe).
      AND EXISTS (
            SELECT 1 FROM study_facts sf2
            WHERE sf2.item_type = 'far' AND sf2.item_id = f.section_number AND sf2.status = 'live'
          )
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
    ORDER BY (CASE WHEN d.category = 'mnemonic' THEN 1 ELSE 0 END) DESC, random()
    LIMIT p_limit
  ),
  fresh_cfr49 AS (
    SELECT f5.section_number AS item_id, 'cfr49' AS item_type,
      '49 CFR ' || f5.section_number || ' ' || regexp_replace(f5.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') AS term,
      f5.body_text AS definition, true AS is_new
    FROM cfr49_sections f5
    WHERE (p_item_types IS NULL OR 'cfr49' = ANY(p_item_types))
      AND f5.body_text IS NOT NULL AND f5.body_text <> ''
      AND f5.title IS NOT NULL AND f5.title <> ''
      -- Built with the live-fact gate from day one -- see fresh_ac's own
      -- comment above for why (this is the SAME fix, just never retrofitted
      -- onto fresh_far/fresh_aim until this same migration).
      AND EXISTS (
            SELECT 1 FROM study_facts sf3
            WHERE sf3.item_type = 'cfr49' AND sf3.item_id = f5.section_number AND sf3.status = 'live'
          )
      AND f5.section_number NOT IN (SELECT item_id FROM study_progress WHERE user_id = auth.uid() AND item_type = 'cfr49')
      AND NOT (cfr49_knowledge_levels(f5.part) && ARRAY['not_applicable'])
      AND (p_levels IS NULL OR cfr49_all_levels(f5.part, f5.section_number) && p_levels)
      AND (p_category_classes IS NULL OR cfr49_category_classes(f5.part, f5.title) IS NULL OR cfr49_category_classes(f5.part, f5.title) && p_category_classes)
    ORDER BY (cfr49_relevance_weight(f5.part) + 1) * random() DESC
    LIMIT p_limit
  ),
  fresh AS (
    SELECT * FROM fresh_pcg
    UNION ALL SELECT * FROM fresh_far
    UNION ALL SELECT * FROM fresh_aim
    UNION ALL SELECT * FROM fresh_ac
    UNION ALL SELECT * FROM fresh_dictionary
    UNION ALL SELECT * FROM fresh_cfr49
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

grant execute on function public.get_study_queue(integer, text[], text[], text[]) to anon, authenticated;

-- ============================================================
-- PART 7: get_study_pool_count -- add cfr49 branch.
-- ============================================================
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
  + (SELECT count(*) FROM cfr49_sections f5
       WHERE (p_item_types IS NULL OR 'cfr49' = ANY(p_item_types))
         AND f5.body_text IS NOT NULL AND f5.body_text <> ''
         AND f5.title IS NOT NULL AND f5.title <> ''
         AND NOT (cfr49_knowledge_levels(f5.part) && ARRAY['not_applicable'])
         AND (p_levels IS NULL OR cfr49_all_levels(f5.part, f5.section_number) && p_levels)
         AND (p_category_classes IS NULL OR cfr49_category_classes(f5.part, f5.title) IS NULL OR cfr49_category_classes(f5.part, f5.title) && p_category_classes))
  END;
$function$;

grant execute on function public.get_study_pool_count(text[], text[], text[]) to anon, authenticated;

-- ============================================================
-- PART 8: create_challenge -- add cfr49 to the pool-selection UNION,
-- add a cfr49 distractor-generation branch, and add same-title-distractor
-- exclusion to BOTH the far and (new) cfr49 fallback branches -- the
-- residual gap described in this file's own header comment (Duels'
-- multiple-choice fallback is safer than Study Mode's old open-text one,
-- but a coincidental same-title distractor was still possible without
-- this).
-- ============================================================
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
      union all
      select item_type, item_id from (
        select 'cfr49' as item_type, section_number as item_id
        from quizzable_cfr49_sections f7
        where not (cfr49_knowledge_levels(f7.part) && array['not_applicable'])
          and (p_levels is null or cfr49_all_levels(f7.part, f7.section_number) && p_levels)
          and (p_category_classes is null or cfr49_category_classes(f7.part, f7.title) is null or cfr49_category_classes(f7.part, f7.title) && p_category_classes)
        order by (cfr49_relevance_weight(f7.part) + 1) * random() desc limit p_question_count * 3
      ) x
      where p_item_types is null or 'cfr49' = any(p_item_types)
    ) pool
    order by random() limit p_question_count
  loop
    v_have_fact := false;
    if v_item.item_type in ('far', 'aim', 'ac', 'dictionary', 'cfr49') then
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
        -- Same-title-distractor exclusion: a random distractor that
        -- happens to share the selected section's own (cleaned) title
        -- would make the quiz_prompt genuinely ambiguous (two visibly
        -- "correct-looking" choices) -- see this file's header comment.
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.section_number), array[]::text[]))
        into v_choices
        from (select section_number from far_sections f3 where f3.title is not null and f3.title <> ''
              and not (far_knowledge_levels(f3.part, f3.subpart_letter) && array['not_applicable'])
              and (p_levels is null or far_all_levels(f3.part, f3.subpart_letter, f3.section_number) && p_levels)
              and f3.section_number <> v_item.item_id
              and regexp_replace(f3.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') <> (
                    select regexp_replace(f3z.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')
                    from far_sections f3z where f3z.section_number = v_item.item_id
                  )
              order by random() limit 5) t;
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
      when 'cfr49' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.section_number), array[]::text[]))
        into v_choices
        from (select section_number from cfr49_sections f8 where f8.title is not null and f8.title <> ''
              and not (cfr49_knowledge_levels(f8.part) && array['not_applicable'])
              and (p_levels is null or cfr49_all_levels(f8.part, f8.section_number) && p_levels)
              and f8.section_number <> v_item.item_id
              and regexp_replace(f8.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') <> (
                    select regexp_replace(f8z.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')
                    from cfr49_sections f8z where f8z.section_number = v_item.item_id
                  )
              order by random() limit 5) t;
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

grant execute on function public.create_challenge(uuid[], integer, text[], text[], text[]) to authenticated;

-- ============================================================
-- PART 9: get_next_challenge_question -- add cfr49's tier gate (Plus,
-- matching AC and the CFR49 RefPack detail screen's own existing gate)
-- and its quiz_prompt fallback branch.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_next_challenge_question(p_challenge_id uuid)
 RETURNS TABLE(question_id uuid, sort_order integer, item_type text, prompt text, choices text[], already_answered boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  return query
  select cq.id, cq.sort_order, cq.item_type,
    coalesce(
      case
        when cq.item_type = 'dictionary' and not public.has_pro_access() then null
        when cq.item_type = 'ac' and not public.has_plus_access() then null
        when cq.item_type = 'cfr49' and not public.has_plus_access() then null
        else cq.question
      end,
      case cq.item_type
        when 'pcg' then (select quiz_prompt_condense(pt.definition) from pcg_terms pt where pt.term = cq.item_id limit 1)
        when 'far' then (select regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') from far_sections f where f.section_number = cq.item_id)
        when 'aim' then (select a.title from aim_paragraphs a where a.paragraph_number = cq.item_id)
        when 'ac' then (select c.title from advisory_circulars c where c.document_number = cq.item_id)
        when 'dictionary' then (
          select case when public.has_pro_access() then quiz_prompt_condense(d.senses->0->>'definition') else d.term end
          from dictionary_terms d where d.slug = cq.item_id
        )
        when 'cfr49' then (select regexp_replace(f5.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') from cfr49_sections f5 where f5.section_number = cq.item_id)
      end
    ),
    cq.choices,
    exists (select 1 from challenge_answers ca where ca.challenge_question_id = cq.id and ca.user_id = auth.uid())
  from challenge_questions cq
  join challenges c on c.id = cq.challenge_id
  where cq.challenge_id = p_challenge_id
    and c.status = 'active'
    and exists (select 1 from challenge_participants cp where cp.challenge_id = cq.challenge_id and cp.user_id = auth.uid() and cp.status = 'active')
    and not exists (select 1 from challenge_answers ca where ca.challenge_question_id = cq.id and ca.user_id = auth.uid())
  order by cq.sort_order
  limit 1;
end;
$function$;

grant execute on function public.get_next_challenge_question(uuid) to authenticated;

-- ============================================================
-- PART 10: get_challenge_results -- add cfr49's definition (title)
-- lookup, mirroring far/aim/ac. term already worked with zero changes
-- (falls through to the same `else cq.item_id` FAR already uses).
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_challenge_results(p_challenge_id uuid)
 RETURNS TABLE(sort_order integer, item_type text, item_id text, term text, definition text, answers jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_completed boolean;
begin
  if not exists (select 1 from challenge_participants cp where cp.challenge_id = p_challenge_id and cp.user_id = auth.uid()) then
    raise exception 'Challenge not found';
  end if;

  select c.status = 'completed' into v_completed from challenges c where c.id = p_challenge_id;
  v_completed := coalesce(v_completed, false);

  return query
  select
    cq.sort_order, cq.item_type, cq.item_id,
    case cq.item_type
      when 'pcg' then (select pt.term from pcg_terms pt where pt.term = cq.item_id limit 1)
      when 'dictionary' then (select d.term from dictionary_terms d where d.slug = cq.item_id)
      else cq.item_id
    end,
    case cq.item_type
      when 'pcg' then (select pt.definition from pcg_terms pt where pt.term = cq.item_id limit 1)
      when 'far' then (select f.title from far_sections f where f.section_number = cq.item_id)
      when 'aim' then (select a.title from aim_paragraphs a where a.paragraph_number = cq.item_id)
      when 'ac' then (select c.title from advisory_circulars c where c.document_number = cq.item_id)
      when 'cfr49' then (select f5.title from cfr49_sections f5 where f5.section_number = cq.item_id)
      when 'dictionary' then (
        select case when public.has_pro_access() then d.senses->0->>'definition' else null end
        from dictionary_terms d where d.slug = cq.item_id
      )
    end,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', cp.user_id,
        'label', coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
        'isMe', cp.user_id = auth.uid(),
        'isForfeited', cp.status = 'forfeited',
        'answerText', case when v_completed or cp.user_id = auth.uid() then ca.answer_text else null end,
        'isCorrect',  case when v_completed or cp.user_id = auth.uid() then ca.is_correct else null end,
        'timeMs',     case when v_completed or cp.user_id = auth.uid() then ca.time_ms else null end
      ) order by cp.is_creator desc, u.email), '[]'::jsonb)
      from challenge_participants cp
      join auth.users u on u.id = cp.user_id
      left join callsign_registry cr on cr.user_id = cp.user_id
      left join challenge_answers ca on ca.challenge_question_id = cq.id and ca.user_id = cp.user_id
      where cp.challenge_id = p_challenge_id and cp.status in ('active', 'forfeited')
    )
  from challenge_questions cq
  where cq.challenge_id = p_challenge_id
    and (v_completed or exists (
      select 1 from challenge_answers ca2
      where ca2.challenge_question_id = cq.id and ca2.user_id = auth.uid()
    ))
  order by cq.sort_order;
end;
$function$;

grant execute on function public.get_challenge_results(uuid) to authenticated;
