-- Applies the same ACS/PTS-citation-density relevance signal already built
-- for Study Mode/Duels (far_relevance_weight()/ac_relevance_weight()) to
-- DailyReg and DailyWord -- RC, 2026-08-12: "the most important things to
-- know/learn should be presented... if the ACS/PTS work helped clarify
-- that for duel and study, use that same sorting for DR and DW as well."
--
-- Both functions need WEIGHTED but DETERMINISTIC selection -- unlike Study/
-- Duel's `ORDER BY (weight+1) * random()` (re-rolled per fetch, fine for a
-- session queue), DailyReg/DailyWord must show the SAME term to every
-- viewer all day (that's the whole "daily" contract -- both functions are
-- already keyed on `hashtext(for_date)`, not per-user). `weight * random()`
-- would make repeat calls within the same day return different rows.
-- Fixed via weighted BUCKETING instead: each row gets a slice of a fixed
-- 0..total_weight range proportional to (weight+1); hashtext(date) %
-- total_weight picks a point, and whichever row's bucket contains it wins.
-- Weighted, but still a pure function of the date, so it's stable across
-- every call/every viewer that day, exactly like the unweighted version.
--
-- Two real problems found and fixed while building this, neither of which
-- Study/Duel's own design has to deal with:
--
-- 1. DailyReg's pool mixes FAR + AIM + AC into ONE combined feed, unlike
--    Study/Duel where each type has its own separate candidate pool drawn
--    independently. A first version bucketed the WHOLE merged pool by raw
--    weight and, live-tested across 300 simulated dates, FAR won 298/300 --
--    AC never won once. Root cause: FAR's raw ACS/PTS weight is
--    concentrated in a few very-cited parts (Part 91 = 371) while AC's is
--    spread thin across many more distinct documents, so FAR's aggregate
--    weight mass dwarfs AC's entirely once pooled together. Fixed with a
--    two-stage pick: which CONTENT TYPE first (a separate, evenly-balanced
--    3-way date-hash rotation -- confirmed live, ~114/105/81 split across
--    300 simulated dates), THEN a weighted pick within that type's own
--    pool. AIM's own "type slot" still fires on its normal ~1/3 share of
--    days even though it carries no weight signal (see #2) -- it just
--    picks uniformly within itself on those days, same as before this
--    change, rather than being crowded out by FAR/AC entirely.
--
-- 2. Raw ACS/PTS weight, even within one type, concentrates too hard for a
--    once-a-day feature. Live-tested: Part 91 alone won 813/1000 simulated
--    FAR-type days using the RAW far_relevance_weight() value directly --
--    a real pilot using the app daily would notice "it's always Part 91."
--    (Study/Duel's own 45%-on-Part-91 figure, already validated as good,
--    is a fairer comparison than it looks: that's 45% of draws WITHIN a
--    multi-item session queue, not 45%+ of every single day of a feature a
--    user sees once daily -- the same raw number reads very differently at
--    daily-feature cadence.) Dampened with floor(sqrt(weight)) -- Part 91
--    drops to 413/1000 (41.3%, now genuinely comparable to Study/Duel's own
--    number) with a real, healthy long tail of other legitimately-cited
--    parts (121, 61, 25, 29, 135, 27, 93...) instead of being crowded out.
--    AC's own raw weights are already small/well-spread enough that
--    dampening barely changes its distribution -- applied the same sqrt for
--    consistency, not because AC needed it as urgently as FAR did.
--
-- Honest limitation, NOT silently worked around: AIM gets no per-item
-- weight at all, unlike FAR/AC. Confirmed by direct inspection of
-- acs_tasks.references_text (the ACS/PTS extractor's own source data):
-- every ACS/PTS citation of the AIM is the bare word "AIM", never a
-- specific paragraph ("AIM 4-3-1") -- acs_citation_density's own AIM row
-- proves this (`cited_id = 'AIM'`, one single undifferentiated bucket, not
-- one per paragraph like FAR/AC get). Also checked whether corpus-wide
-- document_citations (which DOES carry specific AIM paragraph IDs from
-- ordinary body-text citations) could substitute -- too sparse: only 74
-- total AIM citations corpus-wide, max 2-4 per paragraph, nowhere near
-- Part 91's real 371. AIM facts get weight 0 (picked uniformly within the
-- AIM type-slot, same baseline as any FAR part/AC series with zero ACS/PTS
-- citations today) rather than a fabricated number -- a real, structural
-- data gap in the source ACS/PTS text itself, not something a regex fix
-- could close.
--
-- DailyWord (dictionary_terms) has NO ACS/PTS signal at all -- that
-- reference text never cites glossary terms, so there's nothing to reuse
-- directly. Built the real EQUIVALENT instead: dictionary_terms.pcg_term_id
-- (233 of 9,813 terms that share an exact headword with the FAA's own
-- official Pilot/Controller Glossary, from the 2026-08-01 cross-link pass)
-- is a genuine "FAA-confirmed test-relevant vocabulary" signal, same spirit
-- as ACS/PTS citation density (an FAA-authored source vouching for
-- importance) even though it's a different table. No sqrt-dampening needed
-- here -- it's a binary 233-vs-9,580 tier, not one outlier term, so there's
-- no single-item-domination risk the way Part 91 posed for FAR. Weight 20
-- for a P/CG-linked term, 0 otherwise; live-tested over 1000 simulated
-- days: P/CG-tier terms win ~16.7% of days (a real ~7x boost over their
-- ~2.4% raw share of the pool) while the broader pool still shows 775
-- distinct regular terms across the same 1000-day sample -- a real bias
-- toward official vocabulary without starving variety.

CREATE OR REPLACE FUNCTION public.get_reg_of_the_day(for_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(slug text, term text, definition text, source_type text)
 LANGUAGE sql
 STABLE
AS $function$
  with far_pool as (
    select item_id as slug, question as term, answer as definition, 'far'::text as source_type,
           floor(sqrt(far_relevance_weight(split_part(item_id, '.', 1))))::int as weight
    from study_facts
    where item_type = 'far' and status = 'live'
      and question is not null and question <> '' and answer is not null and answer <> ''
  ),
  aim_pool as (
    select item_id as slug, question as term, answer as definition, 'aim'::text as source_type, 0 as weight
    from study_facts
    where item_type = 'aim' and status = 'live'
      and question is not null and question <> '' and answer is not null and answer <> ''
  ),
  ac_pool as (
    select document_number as slug, title as term,
           (description || ' · ' || document_number) as definition, 'ac'::text as source_type,
           floor(sqrt(ac_relevance_weight(document_number)))::int as weight
    from advisory_circulars
    where status = 'active' and title is not null and title <> '' and description is not null and description <> ''
  ),
  far_b as (select *, sum(weight + 1) over (order by slug rows between unbounded preceding and current row) hi,
                       sum(weight + 1) over (order by slug rows between unbounded preceding and 1 preceding) lo from far_pool),
  aim_b as (select *, sum(weight + 1) over (order by slug rows between unbounded preceding and current row) hi,
                       sum(weight + 1) over (order by slug rows between unbounded preceding and 1 preceding) lo from aim_pool),
  ac_b as (select *, sum(weight + 1) over (order by slug rows between unbounded preceding and current row) hi,
                      sum(weight + 1) over (order by slug rows between unbounded preceding and 1 preceding) lo from ac_pool),
  far_t as (select sum(weight + 1) tw from far_pool),
  aim_t as (select sum(weight + 1) tw from aim_pool),
  ac_t as (select sum(weight + 1) tw from ac_pool),
  type_pick as (select (abs(hashtext('regtype-' || for_date::text)) % 3) as t)
  select b.slug, b.term, b.definition, b.source_type
  from type_pick tp
  cross join lateral (
    select * from far_b b, far_t t
    where tp.t = 0 and (abs(hashtext('reg-' || for_date::text)) % t.tw) >= coalesce(b.lo, 0)
      and (abs(hashtext('reg-' || for_date::text)) % t.tw) < b.hi
    union all
    select * from aim_b b, aim_t t
    where tp.t = 1 and (abs(hashtext('reg-' || for_date::text)) % t.tw) >= coalesce(b.lo, 0)
      and (abs(hashtext('reg-' || for_date::text)) % t.tw) < b.hi
    union all
    select * from ac_b b, ac_t t
    where tp.t = 2 and (abs(hashtext('reg-' || for_date::text)) % t.tw) >= coalesce(b.lo, 0)
      and (abs(hashtext('reg-' || for_date::text)) % t.tw) < b.hi
  ) b
  where public.has_pro_access() or auth.role() = 'service_role';
$function$;

CREATE OR REPLACE FUNCTION public.get_word_of_the_day(for_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(slug text, term text, definition text, source text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with pool as (
    select slug, term, (senses->0->>'definition') as definition, source,
           case when pcg_term_id is not null then 20 else 0 end as weight
    from dictionary_terms
    where senses->0->>'definition' is not null
      and length(senses->0->>'definition') >= 40
      and (senses->0->>'definition') not ilike 'see %'
  ),
  bucketed as (
    select *,
           sum(weight + 1) over (order by slug rows between unbounded preceding and current row) as bucket_hi,
           sum(weight + 1) over (order by slug rows between unbounded preceding and 1 preceding) as bucket_lo
    from pool
  ),
  totaled as (select sum(weight + 1) as total_weight from pool)
  select b.slug, b.term,
         case when public.has_plus_access() then b.definition else null end as definition,
         b.source
  from bucketed b, totaled t
  where (abs(hashtext('word-' || for_date::text)) % t.total_weight) >= coalesce(b.bucket_lo, 0)
    and (abs(hashtext('word-' || for_date::text)) % t.total_weight) < b.bucket_hi;
$function$;
