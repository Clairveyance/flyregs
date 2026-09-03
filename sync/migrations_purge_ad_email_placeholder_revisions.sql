-- Purge 4 false "Changed" entries caused by our own AD email-redaction string.
-- WRITTEN 2026-09-02, NOT RUN -- needs RC's go-ahead (it deletes rows).
--
-- Every AD in the app's "Changed" tab is a false positive. All four were
-- logged on 2026-08-17 and none of them reflects an FAA amendment: the AD
-- scraper changed how it renders a redacted email address, from the prose
-- "an email address not captured in this record (see faa.gov for current AD
-- contact information)" to the raw scraped Cloudflare placeholder
-- "[email&#160;protected]". That substitutes one real phrase for another,
-- which is precisely what revision_log.py's _normalize_for_diff cannot catch
-- -- its filters handle label prefixes, private-use sentinels, empty table
-- cells, whitespace and clause punctuation, none of which apply here. The run
-- should have set SKIP_REVISION_LOG=1 and did not.
--
-- Verified before writing this: all four rows carry the placeholder on one
-- side of the diff, and normalising just that placeholder makes both sides
-- identical -- i.e. zero FAA content difference. Same class as the
-- 2026-09-01 table-reformat purge (121 rows) that RC caught himself.
--
-- Telling a pilot an AIRWORTHINESS DIRECTIVE changed when it did not is the
-- one thing this feature exists to get right, which is why these should go.

-- Expect 4.
select count(*) as before_count from content_revisions
 where doc_type = 'ad' and doc_key in ('2026-15-11','2026-15-17','2026-16-01','2026-16-02');

delete from content_revisions
 where doc_type = 'ad'
   and doc_key in ('2026-15-11','2026-15-17','2026-16-01','2026-16-02');

-- Expect 0.
select count(*) as after_count from content_revisions
 where doc_type = 'ad' and doc_key in ('2026-15-11','2026-15-17','2026-16-01','2026-16-02');

-- SEPARATE, BIGGER PROBLEM, not fixed here: 25 live ADs display the literal
-- string "[email protected]" (with a U+00A0) in their body text where an email
-- address belongs -- the Cloudflare obfuscation placeholder, scraped verbatim
-- and shown to users. Verified: 25 rows match
--   select count(*) from airworthiness_directives
--    where body_text like '%[email%protected]%';
-- The old prose sentence was at least honest about what was missing; this
-- reads like a broken page. Fixing it belongs in ad_scraper.py's redaction
-- step, and re-running that will itself log another round of false revisions
-- unless SKIP_REVISION_LOG=1 is set.
