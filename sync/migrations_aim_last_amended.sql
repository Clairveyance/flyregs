-- AIM real per-paragraph change dates (2026-08-05, task #299).
--
-- Unlike FAR (see migrations_far_last_amended.sql), the FAA does not
-- publish a per-paragraph version history for the AIM anywhere -- there
-- is no AIM equivalent of eCFR's Versions API. The only real, FAA-sourced
-- signal available is the AIM's own "Explanation of Changes" page
-- (chap0_section_0.html), which names the specific paragraph numbers
-- touched in the CURRENT edition, alongside a single "Effective: <date>"
-- for that whole edition. There is no archive of past editions' EoC
-- pages, so this can only ever date the paragraphs the FAA chose to call
-- out in the edition currently live -- most paragraphs will stay NULL,
-- meaning "no FAA-confirmed change date available," not "never changed."
-- This is honest coverage, not a bug -- do not backfill NULL with a guess.
ALTER TABLE public.aim_paragraphs
  ADD COLUMN IF NOT EXISTS last_amended date;

COMMENT ON COLUMN public.aim_paragraphs.last_amended IS
  'Real FAA-confirmed date this paragraph was last revised, sourced from '
  'the current edition''s Explanation of Changes page. NULL means no '
  'confirmed date is available (most paragraphs), not "never changed."';
