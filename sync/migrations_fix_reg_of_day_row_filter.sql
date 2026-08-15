-- RC, 2026-08-13, real screenshot: "You got rid of the DR box. even in low
-- tiers it should be here below WN, w/ a lock on it." Root cause: the
-- 2026-08-12 study_facts anonymous-leak fix (migrations_fix_study_facts_
-- anonymous_leak.sql) converted get_reg_of_the_day() to SECURITY DEFINER
-- but left its existing `where has_pro_access() or auth.role() =
-- 'service_role'` clause in place, believing it was "already correct."
-- It isn't, for THIS function specifically -- that WHERE filters the row
-- out of the result set entirely for non-Pro callers, so getDailyReg()
-- gets back an empty array, DailyReg state stays null, and index.tsx's
-- `if (!dailyReg) return null` hides the WHOLE card -- including the
-- locked/teaser variant DailyRegCard already has built for exactly this
-- case (`if (!isPro) return <locked card>`). The client was always
-- designed to receive a row and decide what to show; the RPC just never
-- gave it one below Pro.
--
-- Fix mirrors the established `_gated`-view convention already used
-- elsewhere in this same file (study_facts_gated) and get_word_of_the_day
-- (its own sibling rotation function, which nulls `definition` for
-- non-Plus but always returns the row): keep the exact same deterministic
-- daily-pick logic unchanged, just move the gate from a row-filtering
-- WHERE to column-level redaction on the final SELECT. Nulls BOTH term
-- and definition for non-Pro/non-service_role (not just definition, unlike
-- word_of_the_day) since DailyRegCard's locked variant shows a fully
-- generic teaser and never reads either field -- no reason to leak today's
-- actual pick as a free preview. slug/source_type stay visible; neither is
-- proprietary (source_type is just 'far'/'aim'/'ac', slug points to
-- content already free to browse in the FAR/AIM/AC list views).

create or replace function public.get_reg_of_the_day(for_date date default CURRENT_DATE)
returns table(slug text, term text, definition text, source_type text)
language sql
stable
security definer
as $function$
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
