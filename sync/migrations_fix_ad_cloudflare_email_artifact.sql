-- Real data-quality bug found 2026-08-13 (RC): 4,940 airworthiness_directives
-- rows have "[email&#160;protected]" verbatim in body_text -- Cloudflare's
-- own JS-required email-obfuscation fallback text (shown to any client that
-- doesn't run its decode script, which our scraper doesn't), not garbage.
-- The real email is genuinely unrecoverable from what's already scraped:
-- Cloudflare stores it hex-XOR-encoded in a data-cfemail HTML attribute
-- alongside this fallback text, and the scraper's HTML-to-text extraction
-- (sync/ad_scraper.py) only ever kept the rendered text, not tag attributes.
-- Re-fetching ~4,940 Federal Register pages to decode it is real cost for
-- an address most users will never need (AMOC-request contact info, not
-- safety-critical AD content) -- and it's boilerplate correspondence detail,
-- not core regulatory text, so honesty beats completeness here: replace the
-- broken placeholder with a clear note instead of fabricating an address.
-- Every occurrence checked before writing this (all 4,940) is the identical
-- literal string, always directly after "email:"/"e-mail" and a real phone
-- number that remains a working, unaffected contact method.

update airworthiness_directives
set body_text = replace(
  body_text,
  '[email&#160;protected]',
  'an email address not captured in this record (see faa.gov for current AD contact information)'
)
where body_text like '%[email&#160;protected]%';

-- Same artifact, smaller spillover into 2 other scraped-text columns
-- (checked all 6 body-of-text columns on this table; only these 2 plus
-- body_text above had any occurrences).
update airworthiness_directives
set applicability = replace(
  applicability,
  '[email&#160;protected]',
  'an email address not captured in this record (see faa.gov for current AD contact information)'
)
where applicability like '%[email&#160;protected]%';

update airworthiness_directives
set unsafe_condition = replace(
  unsafe_condition,
  '[email&#160;protected]',
  'an email address not captured in this record (see faa.gov for current AD contact information)'
)
where unsafe_condition like '%[email&#160;protected]%';
