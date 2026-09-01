-- study_facts_gated must return NOTHING to a non-Pro caller (2026-09-01)
--
-- RC: "a free user should be seeing NOTHING when it comes to Q/As. they have no
-- access to study, quiz, duels, etc."
--
-- Every other Q/A surface already fails closed for a free user, verified live:
--   get_study_pool_count            -> 0
--   get_study_queue                 -> 0 rows
--   get_study_mastery               -> 0
--   get_study_pool_counts_by_level  -> 0
--   challenge_questions             -> 403 permission denied
--   create_challenge                -> 'Duels requires Premium'
--
-- study_facts_gated was the exception. It redacted question/answer/distractors/
-- source_quote to NULL but still RETURNED THE ROWS, so a free caller could
-- still see how many authored facts exist and for which item_ids. That was a
-- deliberate choice when the view was created (migrations_fix_study_facts_
-- anonymous_leak.sql reasoned the client "never populates the map for a null
-- pair"), but redaction is not the same as no access, and it leaks the shape of
-- paid content.
--
-- It got worse today: migrations_authored_question_schema.sql appended
-- category, q_type and origin WITHOUT wrapping them in has_pro_access(), so a
-- free caller could read the new authored-question metadata outright.
--
-- Fix: gate the ROWS, not just the columns. The per-column CASEs are kept as
-- defence in depth -- if this row filter is ever loosened again, the content
-- still does not travel.
--
-- Client impact checked before applying: getStudyFactsForItems builds a Map and
-- only ever sets entries for non-null question/answer pairs, so an empty result
-- is already a state it handles -- it is what a free user effectively got
-- before. No shipped build regresses.

begin;

create or replace view public.study_facts_gated as
select id, item_type, item_id, status,
  case when has_pro_access() then question     else null::text   end as question,
  case when has_pro_access() then answer       else null::text   end as answer,
  case when has_pro_access() then distractors  else null::text[] end as distractors,
  case when has_pro_access() then source_quote else null::text   end as source_quote,
  created_at, verified_at, verified_model,
  case when has_pro_access() then explanation  else null::text   end as explanation,
  case when has_pro_access() then category     else null::text   end as category,
  case when has_pro_access() then q_type       else null::text   end as q_type,
  case when has_pro_access() then origin       else null::text   end as origin
from public.study_facts
where status = 'live'
  and public.has_pro_access();

commit;

-- VERIFY: a free user GET on study_facts_gated must return [] , not redacted rows.
