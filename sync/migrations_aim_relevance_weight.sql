-- 2026-08-15. RC, on DailyReg: "how is DR pulling it's choice of which reg
-- to display each day? Some seem really interesting, but others are SO out
-- in left field, that i wonder if we should apply a more strict relevance
-- filter on its selection process." Then: "yeah let's build the AIM r/w
-- function" (approving after I traced the cause).
--
-- get_reg_of_the_day() already weights its FAR and AC pools by real
-- signal (far_relevance_weight/ac_relevance_weight, both keyed off
-- acs_citation_density -- how many ACS/PTS checkride tasks cite that
-- section/document). The AIM pool's weight was hardcoded to literal 0 for
-- every row -- pure uniform-random selection within that pool, the direct
-- cause of RC's "out in left field" picks.
--
-- acs_citation_density does NOT give AIM the same per-paragraph signal FAR
-- and AC get -- its lone 'aim' row is keyed to the whole document
-- ('AIM', task_count 392), not any individual paragraph, so mirroring
-- far/ac_relevance_weight's exact pattern here would just replace one
-- flat weight (0) with another flat weight (constant), no real
-- differentiation. Real per-paragraph signal instead: document_citations,
-- the MagicLink cross-reference table -- how many times OTHER regulatory
-- documents (FAR, AC, AD, etc.) actually cite a given AIM paragraph.
-- Checked live: cited_id for AIM rows is the bare paragraph_number
-- ("4-1-9"), matching study_facts.item_id for item_type='aim' exactly, no
-- transform needed (unlike far_relevance_weight, which extracts just the
-- part number out of a longer FAR citation string).
--
-- Coverage: 62 of 428 quizzable AIM paragraphs (~14%) are cited by
-- something else at least once, 1-4 times each. The other ~86% keep
-- weight 0, same as before -- get_reg_of_the_day()'s own banding
-- (floor(sqrt(weight))+1 width per item) already gives every zero-weight
-- item a real floor chance, so this doesn't silence the long tail, it
-- just stops burying the paragraphs other documents actually lean on
-- underneath them.
create or replace function public.aim_relevance_weight(p_paragraph_number text)
returns integer
language sql
stable
as $$
  select coalesce(
    (select count(*)::integer from document_citations where cited_type = 'aim' and cited_id = p_paragraph_number),
    0
  );
$$;

grant execute on function public.aim_relevance_weight(text) to authenticated, anon;

create or replace function public.get_reg_of_the_day(for_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(slug text, term text, definition text, source_type text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  with far_pool as (
    select item_id as slug, question as term, answer as definition, 'far'::text as source_type,
           floor(sqrt(far_relevance_weight(split_part(item_id, '.', 1))))::int as weight
    from study_facts
    where item_type = 'far' and status = 'live'
      and question is not null and question <> '' and answer is not null and answer <> ''
  ),
  aim_pool as (
    select item_id as slug, question as term, answer as definition, 'aim'::text as source_type,
           floor(sqrt(aim_relevance_weight(item_id)))::int as weight
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
  type_pick as (select (abs(hashtext('regtype-' || for_date::text)) % 3) as t),
  picked as (
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
  )
  select
    p.slug,
    case when public.has_pro_access() or auth.role() = 'service_role' then p.term else null end as term,
    case when public.has_pro_access() or auth.role() = 'service_role' then p.definition else null end as definition,
    p.source_type
  from picked p;
$function$;
