-- A duel prompt that reads "Scope." cannot be answered.
--
-- RC, 2026-09-04: flashcards and duel questions "need to be real and
-- interactive, simple, relevant test-style Q/As, not obscure junk we've had
-- in the past." Found while sampling real gameplay: a cfr49 duel prompt of
-- "Form, content, and availability." and, across the FAR pool, 146 sections
-- whose prompt would be a bare generic heading.
--
-- HOW A PROMPT ENDS UP LIKE THAT
-- get_next_challenge_question() uses challenge_questions.question when an
-- authored study_fact exists, and otherwise falls back to the section's own
-- TITLE. That fallback is fine for a specific title ("Persons on board.",
-- "Engine cooling.") and useless for a generic one -- there are 99 sections
-- titled "Applicability." and the prompt carries no Part, so the question is
-- unanswerable even for someone who knows the material cold.
--
--     99x  Applicability.        5x  Application.       2x  Design.
--     19x  General.              3x  Eligibility.       2x  Issuance.
--     12x  Scope.                1x  Definitions./Forms./Reports./Sanctions.
--
-- WHY NOT JUST RE-BAN DUPLICATE TITLES
-- That guard used to exist and was deliberately REMOVED on 2026-08-28: it hid
-- 558 real FAR sections, 25 in Part 61 alone, because sharing a title with a
-- sibling says nothing about whether a section is worth asking about. This is
-- narrower on purpose. It excludes a section ONLY while BOTH are true:
--
--   * the title is one of a short, explicit list of headings that carry no
--     subject on their own, and
--   * no live authored question exists for it
--
-- So the moment author_fact_deck.py writes a real question for § 91.1
-- "Applicability", that section returns to the pool automatically. Nothing is
-- deleted and nothing is permanently excluded -- this is a view.
--
-- Also excludes sections with no body_text at all. Three exist (91.220,
-- 121.326, 129.16) and their prompt would be the literal string "xxx".
-- Checked against the live eCFR before assuming a scraping fault: the eCFR's
-- own structure carries label "§ 91.220 xxx" with reserved=false, so the
-- corpus is faithful and the FAA is the source of the oddity. Still nothing
-- to build a question from.
--
-- Cost: 4,180 -> ~4,019 quizzable FAR sections, under 4%.

create or replace view public.quizzable_far_sections as
select * from (
  select f0.id, f0.section_number, f0.part, f0.subpart_letter, f0.subpart_title,
         f0.title, f0.body_text, f0.updated_at, f0.search_vector,
         regexp_replace(f0.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') as quiz_prompt,
         count(*) over (partition by regexp_replace(f0.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')) as prompt_uses
    from far_sections f0
   where f0.title is not null and f0.title <> ''
     and f0.body_text is not null and length(btrim(f0.body_text)) > 0
) f
where title !~~* '%[reserved%'
  and quiz_prompt !~ '[0-9]+\.[0-9]+'
  and not (
    lower(btrim(quiz_prompt, ' .')) = any (array[
      'applicability', 'general', 'scope', 'application', 'eligibility',
      'issuance', 'definitions', 'forms', 'reports', 'sanctions', 'design',
      'purpose', 'policy', 'introduction', 'overview'])
    and not exists (
      select 1 from study_facts s
       where s.item_type = 'far' and s.item_id = f.section_number and s.status = 'live')
  );

-- Same shape, same reasoning, for 49 CFR -- this is where the prompt that
-- prompted all of it ("Form, content, and availability.") came from.
create or replace view public.quizzable_cfr49_sections as
select * from (
  select f0.id, f0.section_number, f0.part, f0.subpart_title, f0.title,
         f0.body_text, f0.updated_at, f0.search_vector,
         regexp_replace(f0.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') as quiz_prompt,
         count(*) over (partition by regexp_replace(f0.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')) as prompt_uses
    from cfr49_sections f0
   where f0.title is not null and f0.title <> ''
     and f0.body_text is not null and length(btrim(f0.body_text)) > 0
) f
where title !~~* '%[reserved%'
  and quiz_prompt !~ '[0-9]+\.[0-9]+'
  and not (
    lower(btrim(quiz_prompt, ' .')) = any (array[
      'applicability', 'general', 'scope', 'application', 'eligibility',
      'issuance', 'definitions', 'forms', 'reports', 'sanctions', 'design',
      'purpose', 'policy', 'introduction', 'overview',
      'form, content, and availability'])
    and not exists (
      select 1 from study_facts s
       where s.item_type = 'cfr49' and s.item_id = f.section_number and s.status = 'live')
  );
