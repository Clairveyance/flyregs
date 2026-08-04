-- ============================================================================
-- Server-side enforcement of paid-tier content gates
-- -- 2026-08-04/05
--
-- Found during an overnight autonomous QA pass (gotcha_tier_gate_client_
-- side_only.md): every tier-gated content read (AD/AC/LOI full text,
-- Dictionary mnemonic breakdowns, Word of the Day definitions) fetched the
-- COMPLETE paywalled payload unconditionally, for every subscription tier
-- including Free. hasPlusAccess/hasProAccess was checked only at RENDER
-- time to decide whether to *display* the content, never at fetch time to
-- decide whether to *send* it. On web this was trivially readable via any
-- network inspector; the "gate" was a UI choice not to render something
-- already fully received, not real access control.
--
-- Root problem: Postgres had NO queryable source of truth for "is this
-- user currently Plus/Pro/Premium" at all. Every entitlement check, in the
-- app and in Postgres, went straight to RevenueCat's SDK/API at read time.
-- Column-level redaction needs a value RLS can evaluate against; there was
-- none. Fixing this required three things done together, not just an RLS
-- tweak:
--   1. A real DB-backed tier-of-record (user_entitlements) RLS alone can't
--      create -- something has to populate it from RevenueCat's own truth.
--   2. Views that redact the specific gated column per-row using that
--      tier-of-record (Postgres RLS is row-level, not column-level --  you
--      cannot partially redact one column in a plain table policy; a view
--      substituting a CASE expression for the sensitive column is the
--      correct mechanism).
--   3. A way to keep user_entitlements from going stale (see
--      supabase/functions/sync-entitlements and the revenuecat-webhook
--      update, both deployed alongside this migration).
--
-- Security property that matters most: nothing here ever trusts a
-- client-supplied tier claim. sync-entitlements resolves the caller from
-- their own verified JWT, then independently asks RevenueCat's own API
-- what THAT user's real entitlements are -- a forged "I'm Premium" request
-- body has no effect (the body isn't even read). has_plus_access()/
-- has_pro_access() default to false (fail-closed) whenever a user has no
-- user_entitlements row at all (new signup, sync race), never accidental
-- full access.
--
-- Verified live end-to-end (not just by reading the view definitions): a
-- real disposable free-tier account and Ryan's real granted-Premium
-- account were both used to query all 4 gated views and the updated RPC
-- directly via REST, then re-verified through the actual app UI in the
-- Browser pane (free tier correctly redacted/paywalled on every one of the
-- 7 real client call-sites this touched; Premium correctly saw full
-- content on all of them, including a full-length AC scrolled well past
-- the 2-block free-preview boundary). See gotcha_tier_gate_client_side_
-- only.md for the fix's full incident writeup and the 3 additional leaks
-- (beyond the originally-flagged 4) a column-name sweep turned up.
-- ============================================================================


-- ── 1. DB-backed tier-of-record ─────────────────────────────────────────────
-- The only place Postgres can look up "is this user currently entitled"
-- without calling out to RevenueCat on every read. Kept current by
-- sync-entitlements (active path: called right after purchase/restore and
-- once at session-init) and revenuecat-webhook (passive backstop: re-syncs
-- on every RC event, covers renewals/expirations/billing issues that
-- happen while the app isn't open). Client code NEVER writes to this table
-- directly -- no insert/update/delete policy for authenticated at all,
-- only the two Edge Functions (via the service-role key) can write.

create table if not exists public.user_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_pro boolean not null default false,
  is_premium boolean not null default false,
  is_unlocked boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_entitlements enable row level security;

create policy user_entitlements_select_own on public.user_entitlements
  for select using (auth.uid() = user_id);


-- ── 2. Helper functions ─────────────────────────────────────────────────────
-- Single source of truth for "does this user have Plus-or-above" / "Pro-
-- or-above" access, used by every gated view's CASE expression below (and
-- reusable by any future one). coalesce(..., false) is the fail-closed
-- default: a missing row (brand-new user, sync race) means NO access,
-- never accidental access.

create or replace function public.has_plus_access(p_user_id uuid default auth.uid())
returns boolean language sql stable as $$
  select coalesce(
    (select is_unlocked or is_pro or is_premium from public.user_entitlements where user_id = p_user_id),
    false
  );
$$;

create or replace function public.has_pro_access(p_user_id uuid default auth.uid())
returns boolean language sql stable as $$
  select coalesce(
    (select is_pro or is_premium from public.user_entitlements where user_id = p_user_id),
    false
  );
$$;


-- ── 3. Gated views ───────────────────────────────────────────────────────────
-- Every client fetch of these 4 content types now reads from the _gated
-- view instead of the raw table -- see gotcha_tier_gate_client_side_only.md
-- for the full list of call sites this touched (7 total, 3 more than
-- originally flagged). Every column the client already depended on passes
-- through unchanged; only the one gated column per table is redacted.

-- AD: full compliance text (body_text) is Plus+.
create or replace view public.airworthiness_directives_gated as
select id, ad_number, document_number, subject_heading, subject, make, model,
  product_type, product_subtype, status, effective_date, docket_number,
  amendment_number, superseded_ad, affected_ad, superseded_by, affected_by,
  summary, applicability, unsafe_condition,
  case when public.has_plus_access() then body_text else null end as body_text,
  pdf_url, cached_image_url, citation, citation_publish_date, created_at, updated_at
from public.airworthiness_directives;

-- LOI: full interpretation text (body_text) is Pro+.
create or replace view public.legal_interpretations_gated as
select id, slug, doc_unique_id, title, addressee, year, issued_date, source_url,
  pdf_url_cached, cfr_part_reference, cfr_section_reference, summary,
  case when public.has_pro_access() then body_text else null end as body_text,
  size_bytes, text_quality, superseded_by, created_at, updated_at
from public.legal_interpretations;

-- AC: full body (pdf_blocks) is Plus+; non-Plus gets a flat 2-block free
-- preview (RC, 2026-08-03: "free tier can preview 2 sections of an AC, not
-- 5" -- see src/lib/acFormat.ts's previewBlockCount, shared by every
-- screen that renders an AC so the depth can't drift between them).
-- pdf_blocks_total_count is the TRUE block count, computed from the raw
-- (un-redacted) column -- needed because the client's own "there's more,
-- unlock with Plus" CTA can't tell "2 real blocks total" from "60 blocks,
-- showing 2" just from the redacted array's own .length once it's always
-- capped at 2. This is a non-sensitive integer (no body text), safe to
-- expose to every tier.
create or replace view public.advisory_circulars_gated as
select id, document_number, title, date_issued, office, change_number, status,
  subject_series, description, document_id, cancels, pdf_url_faa,
  pdf_url_cached, pdf_size_bytes, pdf_text, last_scraped_at, created_at, updated_at,
  case when public.has_plus_access() then pdf_blocks
       else jsonb_path_query_array(pdf_blocks, '$[0 to 1]') end as pdf_blocks,
  pdf_blocks_version, changed_block_indices,
  coalesce(jsonb_array_length(pdf_blocks), 0) as pdf_blocks_total_count
from public.advisory_circulars;

-- Dictionary: senses (the full letter-by-letter breakdown) is Plus+ for
-- mnemonic-category entries ONLY -- every other category (contractions,
-- glossary terms, etc.) was never gated and stays fully free here. Every
-- mnemonic-category row has non-null senses at the raw-table level
-- (confirmed 0/0 nulls) -- the only reason senses is ever null through this
-- view is tier redaction, never a genuine data gap, so client code can
-- safely treat "senses is null" as an unambiguous "this is gated" signal.
create or replace view public.dictionary_terms_gated as
select id, term, slug, letter, category,
  case when category = 'mnemonic' and not public.has_plus_access() then null
       else senses end as senses,
  source, pcg_term_id, external_refs, updated_at, mnemonic_group, see_also_slug
from public.dictionary_terms;

grant select on public.airworthiness_directives_gated to anon, authenticated;
grant select on public.legal_interpretations_gated to anon, authenticated;
grant select on public.advisory_circulars_gated to anon, authenticated;
grant select on public.dictionary_terms_gated to anon, authenticated;


-- ── 4. Word of the Day RPC ───────────────────────────────────────────────────
-- Same redaction, RPC-shaped instead of view-shaped since this was already
-- an RPC (get_word_of_the_day() picks one dictionary_terms row
-- deterministically by date, unrelated to the mnemonic-only gating above --
-- ANY term can be picked, and its definition is Plus+ regardless of
-- category). Logic otherwise unchanged from the pre-existing rotation.

create or replace function public.get_word_of_the_day(for_date date default current_date)
 returns table(slug text, term text, definition text, source text)
 language sql stable
as $function$
  with pool as (
    select slug, term, (senses->0->>'definition') as definition, source
    from dictionary_terms
    where senses->0->>'definition' is not null
      and length(senses->0->>'definition') >= 40
      and (senses->0->>'definition') not ilike 'see %'
  ),
  ordered as (
    select *, row_number() over (order by slug) - 1 as idx, count(*) over () as total
    from pool
  )
  select slug, term, case when public.has_plus_access() then definition else null end as definition, source
  from ordered
  where idx = (abs(hashtext('word-' || for_date::text)) % total);
$function$;

NOTIFY pgrst, 'reload schema';
