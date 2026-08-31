-- Restore three features that are silently dead for EVERY user (2026-08-31)
--
-- None of these is a leak. All three are the opposite: content and behaviour
-- the app pays to build, which no real user has been receiving. Each was
-- proven live with the public anon key, and each has a control showing the
-- same call works as the DB owner.
--
-- ── 1. search_cfr49 is permission-denied for every real caller ────────────
-- 49 CFR has been silently absent from SmartSearch for everyone -- free
-- through Premium -- since 2026-08-29.
--
--   POST /rest/v1/rpc/search_cfr49 {"query":"hazardous materials"}
--   -> 401 {"code":"42501","message":"permission denied for table cfr49_sections"}
--   control, same caller: search_far -> 200 with real rows
--
-- Cause: search_cfr49 is INVOKER-rights (prosecdef = false) and its body reads
-- cfr49_sections.body_text and .search_vector -- the two columns
-- migrations_fix_cfr49_body_text_column_grant_leak.sql revoked. That migration
-- reasoned only about the gated VIEW ("nothing in the app's real read path is
-- affected either way") and did not account for this invoker-rights RPC.
-- src/lib/unifiedSearch.ts calls it on every search and swallows the error
-- (`cfr49Res.data ?? []`), so it failed silently rather than loudly.
--
-- Fix matches the existing search_ads precedent. This adds NO exposure: the
-- function returns only metadata + rank (never body text) at any tier, and it
-- already clamps depth for non-Plus callers via
-- `case when has_plus_access() then result_limit else least(result_limit, 10) end`.
--
-- ── 2 & 3. Three tables have RLS ENABLED with ZERO policies = deny-all ────
-- The `rls_auto_enable` event trigger turns RLS on for every new table; if
-- nobody then writes a policy, the table is silently invisible to every role
-- except the owner. Proven live (anon key) against real owner-side counts:
--
--   search_vocabulary         -> []   (7,694 rows exist)
--   search_term_associations  -> []   (14,418 rows exist)
--   ac_series                 -> []   (62 rows exist)
--
-- Consequences:
--   * SmartSearch spelling correction and term expansion are DEAD for real
--     users. search_resolve_query / search_resolve_term / expand_search_terms
--     are all invoker-rights, so they see zero vocabulary and return the
--     query unchanged. Confirmed asymmetry: search_acs and search_dictionary
--     ARE SECURITY DEFINER and do correct spelling, so AC search fixes typos
--     while FAR search does not -- from the same search box.
--   * src/lib/filterSearch.ts's AC-series picker in the Filter sheet is empty
--     for everyone.
--
-- These are non-sensitive derived lexicons and public catalogue data. The
-- policies below mirror what search_concept_anchors already has, and
-- ac_series' own fields are already exposed freely through the definer view
-- series_summary -- so none of this widens what any tier can see.

begin;

-- 1. search_cfr49: run with definer rights so the revoked column grants on
--    cfr49_sections stop breaking it, with a pinned search_path.
alter function public.search_cfr49(text, integer) security definer;
alter function public.search_cfr49(text, integer) set search_path to 'public', 'pg_temp';

-- 2. The search lexicons the resolver depends on.
drop policy if exists search_vocabulary_readable on public.search_vocabulary;
create policy search_vocabulary_readable on public.search_vocabulary
  for select using (true);

drop policy if exists search_term_associations_readable on public.search_term_associations;
create policy search_term_associations_readable on public.search_term_associations
  for select using (true);

-- 3. The AC series catalogue behind the Filter sheet's picker.
drop policy if exists ac_series_public_read on public.ac_series;
create policy ac_series_public_read on public.ac_series
  for select using (true);

-- 4. Latent, fix it before it fires: content_revisions_gated redacts diff text
--    for 'ac' and 'ad' only, so a 49 CFR revision would publish gated body
--    text to the free tier. 49 CFR is Plus-gated content, but this view was
--    written before that was established -- its own migration comment says
--    "'cfr49' falls through its ELSE branch automatically, same free-tier
--    treatment as far/aim/pcg already get. No view change needed", which was
--    wrong. Zero cfr49 rows exist today (far 36, aim 18, ad 4), so this is
--    pre-emptive and changes nothing currently visible.
create or replace view public.content_revisions_gated as
select
  id, doc_type, doc_key, doc_id, title,
  case when doc_type = any (array['ac','ad','cfr49']) and not public.has_plus_access()
       then null else added_text end as added_text,
  case when doc_type = any (array['ac','ad','cfr49']) and not public.has_plus_access()
       then null else removed_text end as removed_text,
  revised_at, created_at
from public.content_revisions;

-- 5. Dormant footgun: semantic_search() is still EXECUTE-able by anon while
--    its twin hybrid_search was revoked by the same 2026-08-29 migration.
--    It is invoker-rights over content_chunks (which holds AC/AD/LOI/49 CFR
--    body text) and is inert ONLY because content_chunks has RLS on with zero
--    policies -- i.e. it is one accidental policy away from being a leak.
--    Zero client callers (grep of src/ finds none).
revoke execute on function public.semantic_search(vector, text[], integer)
  from public, anon, authenticated;

commit;

-- VERIFY AFTER APPLYING:
--   search_cfr49 via the anon key      -> 200 with rows (<=10 below Plus), not 401
--   search_vocabulary via the anon key -> non-empty
--   ac_series via the anon key         -> 62 rows
--   semantic_search via the anon key   -> 403 / permission denied
