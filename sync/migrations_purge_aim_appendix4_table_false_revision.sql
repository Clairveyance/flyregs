-- Purge the ONE false "changed" entry the AIM TBL 4-2 table fix will create
-- (write this off AFTER the next weekly AIM sync, not before -- the row it
-- deletes does not exist until that sync runs).
--
-- Same class, and same remedy, as
-- migrations_purge_table_reformat_false_revisions.sql (2026-09-01, 121 rows):
-- our own rendering improvement is not an FAA amendment, and must never appear
-- in What's New as though the FAA changed the AIM.
--
-- WHAT CHANGED AND WHY IT CANNOT BE NORMALIZED AWAY. Appendix 4's TBL 4-2
-- (Item 10a Navigation, Communication, and Approach Aid Capabilities -- the
-- ICAO flight plan equipment codes) was stored as two unusable lines: a bogus
-- 2-cell "header" holding 324 and 481 characters of the table's own body text,
-- over a single 4-cell row with each cell holding an entire column run
-- together. It now renders as a caption plus 19 real
-- "Code | Description | Code | Description" rows (commit 02ea5c6).
--
-- revision_log.py's _normalize_for_diff already absorbs the artifact classes
-- that caused the 121-row incident (private-use sentinels, empty padding
-- cells, whitespace, clause punctuation). It cannot absorb THIS one, and
-- should not: the token ORDER genuinely changes, because the whole point of
-- the fix is that "A GBAS Landing System B LPV..." becomes
-- "A | GBAS Landing System" on its own row. A normalization loose enough to
-- call those equal would be loose enough to miss real FAA amendments, which
-- is a far worse failure than one stale What's New entry. So this is a
-- targeted purge of one known row, not a change to the comparison rules.
--
-- Column names checked against the live table rather than assumed: the
-- identifier lives in doc_key (doc_id is NULL on every row), and the
-- timestamps are revised_at/created_at -- there is no detected_at.
--
-- Deliberately narrow on all three axes -- doc_type + doc_key, a recent
-- window, AND the specific text this fix moves -- so it cannot remove
-- anything but the entry this change creates. If the FAA genuinely amends
-- Appendix 4 later, that revision is logged and kept normally.

delete from content_revisions
where doc_type = 'aim'
  and doc_key = 'appendix_4'
  and created_at >= now() - interval '2 days'
  and (coalesce(added_text, '') like '%GBAS Landing System%'
       or coalesce(removed_text, '') like '%GBAS Landing System%');

-- Verify: expect 0.
select count(*) as remaining_false_revisions
from content_revisions
where doc_type = 'aim'
  and doc_key = 'appendix_4'
  and created_at >= now() - interval '2 days';
