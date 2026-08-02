-- Broadens get_reg_of_the_day() from P/CG-only to a rotation across P/CG +
-- FAR + AIM + AC. RC, live: "make sure the DailyReg isn't just P/CG terms. It
-- should pull diff regs from across the corpus - presenting them pretty
-- much the same way we present the flashcards - in terms of simplicity."
--
-- Confirmed live (pg_get_functiondef) the function only ever selected from
-- pcg_terms. study_facts (the same verified, human-simple question/answer
-- content Study Mode's flashcards already use, see flyregs_pending.md's
-- quiz-pass work) already covers FAR (13,390 live facts) and AIM (2,149
-- live facts) in exactly the flashcard shape this needs -- no new content
-- generation required to widen this 3x.
--
-- AC added in a follow-up pass (2026-08-01, RC: "you can include the ACs.
-- for now just keep them simple - number, title, and maybe a very brief
-- description") -- unlike AD/LOI (still deliberately left out, no
-- equivalent simple Q&A source), ACs already have a real title +
-- description pair in `advisory_circulars` that reads fine as a DailyReg
-- card without any new content generation, same reasoning as FAR/AIM's
-- study_facts reuse above.
--
-- source_type added to the return shape so callers (Home's "Open full
-- entry" jump, the push notification's deep link) can route to the right
-- detail screen (/pcg/:slug, /far/:id, /aim/:id, /ac/:id) instead of
-- assuming PCG.
create or replace function public.get_reg_of_the_day(for_date date default current_date)
returns table(slug text, term text, definition text, source_type text)
language sql
stable
as $$
  with pool as (
    select slug, term, definition, 'pcg' as source_type
    from pcg_terms
    where definition is not null and definition <> ''
    union all
    select item_id as slug, question as term, answer as definition, item_type as source_type
    from study_facts
    where item_type in ('far', 'aim')
      and status = 'live'
      and question is not null and question <> ''
      and answer is not null and answer <> ''
    union all
    select document_number as slug, title as term,
           (description || ' · ' || document_number) as definition,
           'ac' as source_type
    from advisory_circulars
    where status = 'active'
      and title is not null and title <> ''
      and description is not null and description <> ''
  ),
  ordered as (
    select *, row_number() over (order by source_type, slug) - 1 as idx, count(*) over () as total
    from pool
  )
  -- The original P/CG-only version used `doy % total` -- fine when total
  -- (pcg_terms count) was in the same order of magnitude as 366. It breaks
  -- silently once the pool includes study_facts: total jumps to 17,000+,
  -- so `doy % total` just equals `doy` for every possible date (day-of-
  -- year never exceeds 366), meaning only the first ~366 rows of the
  -- pool -- alphabetically all 'aim' since source_type sorts first --
  -- would EVER be selected, forever, on a fixed yearly repeat, and
  -- pcg_terms (sorted last) and most of FAR would never show at all.
  -- Caught before shipping by testing the rotation across real dates.
  -- A hash of the date string maps deterministically (same date always
  -- picks the same row, required since the push job and this in-app card
  -- must agree on "today's" pick) but pseudo-randomly across the FULL
  -- pool range regardless of size, giving real day-to-day variety across
  -- all four source types instead of one long single-type stretch.
  select slug, term, definition, source_type from ordered
  where idx = (abs(hashtext(for_date::text)) % total);
$$;
