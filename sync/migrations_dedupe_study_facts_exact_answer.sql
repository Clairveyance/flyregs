-- Real, corpus-wide study_facts duplication found 2026-08-13 while
-- investigating RC's AIM 4-7-3 report (a fact-backed Study Mode card that
-- looked like "our system mixing things up"). It wasn't a mixup -- AIM
-- 4-7-3 genuinely had 6 live facts, 3 of them near-identical PAIRS
-- ("which AC provides qualification criteria" asked twice, "which OpSpec/
-- MSpec/LOA" asked twice, "which is tighter, RNP 10 or RNP 4" asked
-- twice). Root cause: scripts/author_fact_deck.py's fetch_sources() pulls
-- every matching item on every run with no exclusion for items that
-- already have live facts -- any authoring pass that overlaps a previous
-- one's item set (which the FAR/AIM/AC-truncated $72 pass and earlier
-- passes clearly did) generates fresh near-paraphrase facts for
-- already-covered material instead of skipping it. Confirmed corpus-wide,
-- not a one-off: 3,543 FAR items, 776 AC, 425 AIM, 124 PCG each currently
-- carry more than one live fact, ~37,000 rows total.
--
-- This migration only removes the SAFE, zero-judgment subset: rows on the
-- same item sharing an EXACT (case/whitespace-normalized) answer with
-- another row on that same item -- that's a reliable, mechanical signal
-- the two are testing the identical underlying fact regardless of how the
-- question is worded, not a guess. 7,415 rows qualify. This deliberately
-- does NOT touch the softer case (same fact, paraphrased answer too, e.g.
-- "170 lbs" vs "170 pounds") -- that needs fuzzy/LLM judgment, real cost,
-- and RC's go-ahead first; left as a flagged follow-up, not attempted here.
--
-- Keeper priority per duplicate group: prefer a row with real distractors
-- (needed for Duels' fact-selection query, `distractors is not null and
-- array_length(distractors,1)=3`) over one without, then the OLDEST row
-- (created_at asc) as the stable tiebreak. Confirmed via dry-run that zero
-- of the 7,415 candidates are referenced by any historical
-- challenge_questions.fact_id row (the FK would have blocked those
-- specific deletes anyway -- NO ACTION, not CASCADE -- but none hit it).
with ranked as (
  select id,
    row_number() over (
      partition by item_type, item_id, lower(btrim(answer))
      order by (distractors is not null and array_length(distractors,1)=3) desc, created_at asc
    ) as rn
  from study_facts
  where status = 'live'
)
delete from study_facts
where id in (
  select id from ranked
  where rn > 1
    and id not in (select fact_id from challenge_questions where fact_id is not null)
);
