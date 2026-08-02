-- ============================================================================
-- Question-pool integrity, part 2: prompts that give away their own answer
--                                                            2026-07-31
--
-- D8  A quiz prompt containing its own answer. Measured on the D7 pools:
--       P/CG  134 of 920 definitions contain the term being asked about
--             ("TOUCHDOWN ZONE" -> "...used for determination of Touchdown
--             Zone elevation"; "EXPEDITE" -> "...Expedite climb...").
--       FAR   36 of 2,332 titles contain their own section number, because
--             the display regex only strips a single leading "§ 91.103 " and
--             not a RANGE ("§§ 91.27-91.99 [Reserved]"). 44 contain some
--             section reference.
--       AC    2 of 755 titles begin with the AC number itself (scraper kept
--             the "number, title" prefix -- see the data fix below).
--       AIM   0.
--
-- D9  [Reserved] placeholders are not content. 39 survived the D7 uniqueness
--     filter only because their number RANGES differ, and every one of them
--     is both answerless and a giveaway. Excluded outright.
--
--     Exclusion, not redaction: blanking the term out of a definition was
--     tried twice in Study Mode and rejected both times (see the "no
--     flashcard blanks" standing note), and the same objection applies here.
--     Pools after this pass: FAR 2,257 / AIM 407 / P/CG 786 / AC 753.
-- ============================================================================

-- Data fix: two AC titles carry their own document number as a prefix. That
-- is wrong everywhere the title renders, not just in a duel -- the AC detail
-- header already shows the number directly above it.
update advisory_circulars
set title = regexp_replace(title, '^' || regexp_replace(document_number, '([.*+?^${}()|\[\]\\/-])', '\\\1', 'g') || ',\s*', '')
where title like document_number || '%';

create or replace view public.quizzable_far_sections as
select f.*, regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') as quiz_prompt
from far_sections f
where f.title is not null and f.title <> ''
  and regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') in (
    select regexp_replace(title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')
    from far_sections
    where title is not null and title <> ''
    group by 1 having count(*) = 1
  )
  -- D9: placeholders, not content.
  and f.title not ilike '%[reserved%'
  -- D8: the displayed prompt must not contain any section reference, which
  -- covers both "contains its own number" and "names a neighbouring one".
  and regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') !~ '[0-9]+\.[0-9]+';

create or replace view public.quizzable_aim_paragraphs as
select a.*, a.title as quiz_prompt
from aim_paragraphs a
where a.title is not null and a.title <> ''
  and a.title in (
    select title from aim_paragraphs
    where title is not null and title <> ''
    group by 1 having count(*) = 1
  )
  and position(lower(a.paragraph_number) in lower(a.title)) = 0;

create or replace view public.quizzable_pcg_terms as
select p.*, p.definition as quiz_prompt
from pcg_terms p
where p.definition is not null and p.definition <> '' and p.term is not null
  and p.definition in (
    select definition from pcg_terms
    where definition is not null and definition <> '' and term is not null
    group by 1 having count(*) = 1
  )
  -- position() rather than LIKE: a term containing % or _ would otherwise be
  -- read as a wildcard pattern.
  and position(lower(p.term) in lower(p.definition)) = 0;

create or replace view public.quizzable_advisory_circulars as
select c.*, c.title as quiz_prompt
from advisory_circulars c
where c.status = 'active'
  and c.title is not null and c.title <> ''
  and c.description is not null and c.description <> ''
  and c.title in (
    select title from advisory_circulars
    where status = 'active' and title is not null and title <> ''
      and description is not null and description <> ''
    group by 1 having count(*) = 1
  )
  and position(lower(c.document_number) in lower(c.title)) = 0;
