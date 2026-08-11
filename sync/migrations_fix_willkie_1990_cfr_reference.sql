-- RC: "deal w/ this worktree item: Fix runaway cfr_section_reference on 1
-- LOI (willkie-1990)". Root-caused (sync/loi_scraper.py, see the guard
-- added there in the same commit): cfr_section_reference is pulled
-- verbatim from the FAA DRS API's own "CFR Section Reference" metadata
-- field, not computed by our scraper. For this one document, DRS's own
-- metadata expanded to 1,540 pipe-separated "Sec. 91.X" entries (22KB)
-- reaching 91.1721 -- confirmed via direct read of the actual letter body
-- (already in our body_text, unaffected by this bug) that the letter
-- itself states its own scope precisely: "Subpart D of Part 91 (14 C.F.R
-- Part 91), Sections 91.181 through 91.215". Confirmed this is a genuine
-- one-off DRS anomaly, not a pattern -- every other one of the 1055 LOIs
-- has a normal-sized reference (worst case 27 entries).
--
-- Fix value: the 14 sections that both (a) fall within the letter's own
-- stated 91.181-91.215 range and (b) exist as real, non-reserved sections
-- in far_sections today (91.201 is [Reserved], excluded -- citing a
-- reserved section as "related content" would point at nothing). Current
-- FAR numbering may not be pixel-identical to 1990-era numbering after
-- 35+ years of amendments, but this is grounded in the letter's own
-- explicit stated range against real current data -- incomparably more
-- accurate than the 1,540-entry value it replaces, which included
-- hundreds of sections about entirely unrelated subjects (e.g. Subpart K
-- fractional ownership, Subpart F large aircraft maintenance) that this
-- 1990 travel-reimbursement letter never discusses at all.
UPDATE legal_interpretations
SET cfr_section_reference = 'Sec. 91.181 | Sec. 91.183 | Sec. 91.185 | Sec. 91.187 | Sec. 91.189 | Sec. 91.191 | Sec. 91.193 | Sec. 91.203 | Sec. 91.205 | Sec. 91.207 | Sec. 91.209 | Sec. 91.211 | Sec. 91.213 | Sec. 91.215'
WHERE slug = 'willkie-department-of-commerce-1990';
