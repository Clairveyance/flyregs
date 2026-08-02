-- ============================================================================
-- quizzable_* views: single-pass uniqueness instead of a self semi-join
--                                                            2026-07-31
--
-- Found by the filter audit: create_challenge with a Category/Class filter
-- returned HTTP 500 'canceling statement due to statement timeout' (57014).
-- Picking the AMEL chip in a Duel was a hard error for the user.
--
-- EXPLAIN ANALYZE on one FAR question draw:
--     Nested Loop  (actual time=19..8874 ms)
--       Join Filter: regexp_replace(f.title,...) = regexp_replace(fs.title,...)
--       Rows Removed by Join Filter: 5691417
-- 8.8 SECONDS for five rows. The `quiz_prompt in (select ... group by ...
-- having count(*) = 1)` test was planned as a nested loop that re-ran the
-- title regexp on both sides for ~5.7M row pairs. It stayed under the
-- timeout only while no category filter was applied, because the
-- `p_category_classes is null` short-circuit kept the per-row function out
-- of the plan; adding a category made the planner choose this shape.
--
-- count(*) OVER (PARTITION BY prompt) computes the same thing in one pass.
--
-- Semantics are preserved exactly: the window partitions over the SAME
-- population the old subquery grouped over (every row with a non-empty
-- title), and the [Reserved]/answer-leak filters are applied AFTER the
-- window -- so excluding those rows still cannot change anyone else's
-- uniqueness count, which is what the old subquery did too.
-- ============================================================================

drop view if exists public.quizzable_far_sections;
create view public.quizzable_far_sections as
select f.*
from (
  select f0.*,
    regexp_replace(f0.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') as quiz_prompt,
    count(*) over (
      partition by regexp_replace(f0.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')
    ) as prompt_uses
  from far_sections f0
  where f0.title is not null and f0.title <> ''
) f
where f.prompt_uses = 1
  and f.title not ilike '%[reserved%'
  and f.quiz_prompt !~ '[0-9]+\.[0-9]+';

drop view if exists public.quizzable_aim_paragraphs;
create view public.quizzable_aim_paragraphs as
select a.*
from (
  select a0.*, a0.title as quiz_prompt,
    count(*) over (partition by a0.title) as prompt_uses
  from aim_paragraphs a0
  where a0.title is not null and a0.title <> ''
) a
where a.prompt_uses = 1
  and position(lower(a.paragraph_number) in lower(a.title)) = 0;

drop view if exists public.quizzable_pcg_terms;
create view public.quizzable_pcg_terms as
select p.*
from (
  select p0.*, p0.definition as quiz_prompt,
    count(*) over (partition by p0.definition) as prompt_uses
  from pcg_terms p0
  where p0.definition is not null and p0.definition <> '' and p0.term is not null
) p
where p.prompt_uses = 1
  and position(lower(p.term) in lower(p.definition)) = 0;

drop view if exists public.quizzable_advisory_circulars;
create view public.quizzable_advisory_circulars as
select c.*
from (
  select c0.*, c0.title as quiz_prompt,
    count(*) over (partition by c0.title) as prompt_uses
  from advisory_circulars c0
  where c0.status = 'active'
    and c0.title is not null and c0.title <> ''
    and c0.description is not null and c0.description <> ''
) c
where c.prompt_uses = 1
  and position(lower(c.document_number) in lower(c.title)) = 0;

grant select on public.quizzable_far_sections to anon, authenticated;
grant select on public.quizzable_aim_paragraphs to anon, authenticated;
grant select on public.quizzable_pcg_terms to anon, authenticated;
grant select on public.quizzable_advisory_circulars to anon, authenticated;
