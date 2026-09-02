-- Light up the AD "Superseded" warning, which has never once fired.
-- WRITTEN 2026-09-02, NOT RUN -- needs RC's go-ahead. See the safety note.
--
-- THE PROBLEM. Every one of the 5,620 rows in airworthiness_directives reads
-- status = 'Current', because ad_scraper.py hardcodes it (line ~485) and
-- nothing ever reconciles it. The columns the READER actually keys on --
-- superseded_by (the amber "Superseded" pill, ad/[id].tsx:662) and
-- affected_by (the "Superseded by AD X" row, ad/[id].tsx:690) -- are NULL on
-- all 5,620 rows and are written by nothing, anywhere. Both UI paths are
-- therefore dead code, which is also a standing "no dormant unrun code"
-- violation.
--
-- Meanwhile 92 ADs are named as superseded by a LATER AD that we already
-- hold. A mechanic looks one up, sees no warning at all, and may act on a
-- directive that was replaced -- in the worst case here, six years ago
-- (2014-12-07, superseded by 2020-18-19, Agusta/Leonardo AB412).
--
-- WHY THIS IS SAFE TO DERIVE FROM OUR OWN DATA. Verified 2026-09-02:
--   * 92 pairs total, and in 92 of 92 the replacement's effective_date is
--     STRICTLY LATER than the superseded AD's. Zero exceptions. A parsing
--     false positive would almost certainly have produced at least one
--     backwards pair, so this invariant is real evidence, not a hope.
--   * Nothing anywhere FILTERS airworthiness_directives on status --
--     every eq('status','active') in the client is on advisory_circulars.
--     So this cannot hide an AD from any list, any search, or any alert.
--     It only adds a warning to a detail screen.
--   * Fully reversible: set the three columns back to NULL / 'Current'.
--
-- THE SAFETY ASYMMETRY, AND WHY THIS WAS NOT AUTO-APPLIED. A missing
-- "superseded" label is bad. A WRONG one is worse -- it could lead a mechanic
-- to disregard an AD that is still in force. The invariant above is strong
-- but is derived from our own parse, not re-verified against the Federal
-- Register. That is a call for a human who is awake.
--
-- BEFORE RUNNING: eyeball the 92 with the SELECT at the bottom.

update airworthiness_directives old
   set superseded_by = newer.ad_number,
       affected_by   = newer.ad_number,
       status        = 'Superseded'
  from airworthiness_directives newer
 where newer.superseded_ad = old.ad_number
   and newer.ad_number <> old.ad_number
   and newer.effective_date > old.effective_date   -- the invariant, enforced
   and old.status = 'Current';

-- Expect 92 rows updated, and 0 remaining.
select count(*) as still_current_but_superseded
  from airworthiness_directives old
 where old.status = 'Current'
   and exists (select 1 from airworthiness_directives newer
                where newer.superseded_ad = old.ad_number
                  and newer.ad_number <> old.ad_number
                  and newer.effective_date > old.effective_date);

-- REVIEW LIST -- run this FIRST, before the update above.
select newer.ad_number as replacement, newer.effective_date as replacement_effective,
       old.ad_number   as superseded,  old.effective_date   as superseded_effective,
       old.make, old.model
  from airworthiness_directives newer
  join airworthiness_directives old on old.ad_number = newer.superseded_ad
 where old.status = 'Current' and newer.ad_number <> old.ad_number
 order by newer.effective_date desc;

-- ROLLBACK, if the review turns up anything wrong:
--   update airworthiness_directives
--      set superseded_by = null, affected_by = null, status = 'Current'
--    where status = 'Superseded';
