-- Real, SEVERE production bug found 2026-08-12 during the post-
-- create_challenge-fix full gating/security re-sweep, while checking that
-- the 440 Opus-repaired study_facts rows are gated the same as any other
-- row (per RC's explicit ask).
--
-- study_facts (the authored Study Mode / Duels quiz question+answer bank,
-- 38,540+ live rows including all 393 live Opus-repaired ones) had SELECT
-- granted directly to BOTH anon and authenticated, with only a
-- status='live' RLS filter -- no tier check at all. Live-verified: a
-- COMPLETELY ANONYMOUS request (no login, just the public anon key) could
-- read the full question/answer content of any live row via a single
-- direct REST call, e.g.
--   GET /rest/v1/study_facts?select=item_id,question,answer&status=eq.live
-- This is the actual authored, verified, monetized Study Mode/Duels
-- content -- not metadata. Every tier's Pro/Premium paywall for that
-- content was fully bypassable by anyone who found the table name (a
-- single curl call), independent of Study Mode's own separate
-- get_study_queue gating gap fixed alongside this one.
--
-- Root cause is the same shape as the ALREADY-FIXED leaks documented in
-- gotcha_tier_gate_client_side_only.md for legal_interpretations/
-- advisory_circulars/airworthiness_directives -- this table was simply
-- never brought into that same pattern when Study Mode/Duels were built.
--
-- Two real consumers of the raw table, checked individually before this
-- fix:
--   - create_challenge(): SECURITY DEFINER already -- reads the raw table
--     under its own (postgres-owner) privileges regardless of caller
--     grants, so revoking anon/authenticated's grant does NOT affect it.
--     Unaffected, no change needed.
--   - get_reg_of_the_day(): was SECURITY INVOKER, reading study_facts
--     directly with the CALLING role's own privileges. It already has a
--     correct `where has_pro_access() or auth.role() = 'service_role'`
--     gate on its OUTPUT, but revoking the caller's table grant would
--     make even a correctly-to-be-rejected Free-tier call fail with a raw
--     "permission denied" 500 instead of a clean empty result, since
--     Postgres checks table privileges before evaluating the final WHERE.
--     Converted to SECURITY DEFINER here -- its own internal gate is
--     unchanged and still does the real access control; this only changes
--     which role's privileges are used to physically read the table,
--     transparently, with zero behavior change for any caller (auth.uid()
--     inside has_pro_access() still resolves the real caller's identity
--     under SECURITY DEFINER, exactly as it already does inside
--     create_challenge).
--
-- Fix, mirroring the existing _gated-view convention exactly
-- (legal_interpretations_gated's CASE WHEN has_pro_access() THEN col ELSE
-- NULL END pattern):
--   1. Revoke the blanket SELECT grant on the raw table.
--   2. Add study_facts_gated, redacting question/answer/distractors/
--      source_quote (the actual proprietary content) to NULL for non-Pro,
--      scoped to status='live' like the RLS policy it replaces.
--   3. Grant SELECT on the gated view to anon/authenticated.
--   4. Convert get_reg_of_the_day to SECURITY DEFINER (see above).
-- src/lib/study.ts's getStudyFactsForItems() (the only client-side direct
-- consumer, used by Study Mode's study.tsx) is updated in the same pass
-- to query study_facts_gated instead of the raw table.

revoke select on public.study_facts from anon, authenticated;

create or replace view public.study_facts_gated as
select
  id,
  item_type,
  item_id,
  status,
  case when public.has_pro_access() then question else null end as question,
  case when public.has_pro_access() then answer else null end as answer,
  case when public.has_pro_access() then distractors else null end as distractors,
  case when public.has_pro_access() then source_quote else null end as source_quote,
  created_at,
  verified_at,
  verified_model
from public.study_facts
where status = 'live';

grant select on public.study_facts_gated to anon, authenticated;

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
