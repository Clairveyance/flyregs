-- Schema for hand-authored questions (2026-09-01)
--
-- RC: "maybe we CAN build all the Qs for the app outside the app. knowing what
-- each part needs, we could build the entire Q/A bank, then insert it into the
-- app... it would be a bit static, but that's something we could revisit a few
-- times a year."
--
-- WHY THIS LANDS IN study_facts RATHER THAN A NEW TABLE: Study, RefPacks and
-- Duels all already read study_facts (Duels via challenge_questions.fact_id),
-- and the study queue picks ITEMS first and filters those by knowledge level.
-- So an authored question attached to a Part 61 Subpart E section is picked up
-- by all three surfaces, in the right filter box, with zero new plumbing.
--
-- The existing UNIQUE (item_type, item_id, question) is the de-dup guard: an
-- authored question that duplicates a generated one cannot be inserted twice.
--
-- Four new columns, all nullable so the 40,328 existing rows are untouched:
--   category    -- study domain, the axis Ready Room had and we did not
--   q_type      -- 'recall' | 'scenario'. The generated bank is 100% recall,
--                  which is why it reads like trivia; scenario questions are
--                  what an examiner actually asks.
--   explanation -- teaches the distinction. source_quote (which exists) only
--                  quotes the reg back; it does not say why the answer matters
--                  or which sibling reg it is confused with.
--   origin      -- 'generated' (the existing bank) vs 'authored'. Drives
--                  selection preference so a small authored batch is not
--                  drowned by 35,275 generated rows under random sampling.

begin;

alter table public.study_facts
  add column if not exists category    text,
  add column if not exists q_type      text,
  add column if not exists explanation text,
  add column if not exists origin      text not null default 'generated';

alter table public.study_facts drop constraint if exists study_facts_q_type_check;
alter table public.study_facts add constraint study_facts_q_type_check
  check (q_type is null or q_type in ('recall', 'scenario'));

alter table public.study_facts drop constraint if exists study_facts_origin_check;
alter table public.study_facts add constraint study_facts_origin_check
  check (origin in ('generated', 'authored'));

-- Selection preference needs this to stay cheap: it is consulted for every
-- item drawn into a study session or a duel.
create index if not exists study_facts_authored_idx
  on public.study_facts (item_type, item_id) where origin = 'authored';

-- Expose the new fields through the gated view, Pro-gated exactly like
-- question/answer already are. Without this the app cannot see them at all --
-- the raw table's SELECT grant was revoked in
-- migrations_fix_study_facts_anonymous_leak.sql and everything reads the view.
-- New columns are APPENDED, never inserted mid-list: CREATE OR REPLACE VIEW
-- can only add columns at the end (it errors with "cannot change name of view
-- column" otherwise), and dropping the view would drop its grants with it.
create or replace view public.study_facts_gated as
select id, item_type, item_id, status,
  case when has_pro_access() then question    else null::text   end as question,
  case when has_pro_access() then answer      else null::text   end as answer,
  case when has_pro_access() then distractors else null::text[] end as distractors,
  case when has_pro_access() then source_quote else null::text  end as source_quote,
  created_at, verified_at, verified_model,
  case when has_pro_access() then explanation else null::text   end as explanation,
  category, q_type, origin
from public.study_facts
where status = 'live';

commit;
