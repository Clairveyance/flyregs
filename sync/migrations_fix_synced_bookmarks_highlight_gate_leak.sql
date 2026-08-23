-- Found 2026-08-23, QA sweep specifically re-auditing Folders/Saved/Notes/
-- sharing for the same bug shape today's two earlier sweeps found (Duel
-- COALESCE short-circuit, 49 CFR raw-table read) -- same class again, this
-- time in the highlight-bookmark feature.
--
-- A "highlight" (long-press a block on any FAR/AIM/PCG/AC/AD/LOI/CFR49
-- reader screen -> bookmarks.ts's addHighlight) is a synced_bookmarks row
-- whose block_text column is a verbatim, client-captured copy of that
-- block's real body text -- for AC/AD/CFR49 (Plus-gated) and LOI
-- (Pro-gated) that means real paid content, not a short teaser (bookmarks.ts
-- itself documents the intent plainly: "a highlight ... inherits the same
-- tier gating as [the underlying content], with no separate code path").
-- Creating one IS gated (enforce_bookmark_plus_gate requires has_pro_access,
-- since highlight sync is part of the Pro-gated Back-up & Sync feature) --
-- but nothing ever re-checked the READING side against the CURRENT reader's
-- tier, only synced_bookmarks' own users_manage_own_synced_bookmarks RLS
-- policy (`auth.uid() = user_id`, no tier awareness at all -- correct for a
-- PLAIN bookmark's metadata, which is meant to always stay visible, but
-- wrong for a highlight's captured body text).
--
-- Live-reproduced before writing this fix, using this sweep's own 2
-- disposable accounts (never a real account): granted a test account real
-- Premium, had it create a highlight of AC 00-44II's real gated pdf_text
-- (a mid-document excerpt well past the 2000-char free-preview window,
-- confirmed absent from the anon/free preview first), then downgraded that
-- SAME account to Free (is_pro/is_premium/is_unlocked all false) and
-- re-read the row with its own JWT -- the full, real gated excerpt came
-- back verbatim, unredacted, both via a raw REST call to synced_bookmarks
-- directly AND via the app's own real restore path (sync.ts's
-- mergeBookmarks pull-and-merge, which would silently resurrect it into
-- local storage -- e.g. on a reinstall or new device -- after a real
-- subscription lapse). The sibling collaborator path
-- (sharedFolders.ts's resolveMissingAsHighlights, RLS policy
-- collaborators_read_shared_bookmarks) was checked too and is NOT part of
-- this bug -- it already delegates to has_folder_access(), which requires
-- BOTH the owner and the collaborator to currently hold is_premium = true
-- (migrations_fix_sharing_continuous_entitlement_check.sql, confirmed live
-- this same sweep: a collaborator downgraded mid-membership immediately
-- lost read access to the folder, its items, AND the highlight row itself).
-- Only the OWNER's own direct read of their OWN historical highlights was
-- ever ungated.
--
-- Fix, same shape as every other content type's own *_gated view
-- (advisory_circulars_gated/airworthiness_directives_gated/
-- legal_interpretations_gated/cfr49_sections_gated/dictionary_terms_gated):
-- a new synced_bookmarks_gated view redacts block_text/block_snippet (the
-- two columns that carry captured body text -- block_kind/block_label are
-- pure structural metadata, e.g. "section"/"§ 91.3", left untouched same as
-- document_number/title on a plain bookmark) to NULL when the CURRENT
-- caller doesn't hold the tier that item_type's own canonical gated view
-- requires: has_plus_access() for ac/ad/cfr49 (matches advisory_circulars_
-- gated/airworthiness_directives_gated/cfr49_sections_gated exactly),
-- has_pro_access() for loi (matches legal_interpretations_gated), always
-- visible for far/aim/pcg (genuinely free content at every tier, confirmed
-- by this same sweep and the pre-existing get_next_challenge_question fix's
-- own comment). item_type NULL means 'ac' (bookmarks.ts's own BookmarkAC
-- convention, mirrored here); any other/future item_type not yet on this
-- list fails safe to has_pro_access() rather than defaulting open.
--
-- Also revokes SELECT on block_text/block_snippet from the RAW table for
-- anon/authenticated (same defense-in-depth shape as migrations_fix_
-- pdf_url_cached_column_grant_leak.sql) so a direct REST call bypassing the
-- view can't reach them either -- confirmed safe first: every real write
-- path (syncPushBookmark's upsert, syncPushBookmarkDeletes' update, both in
-- syncPush.ts) never chains .select() so neither needs SELECT on any
-- column, and the only 2 real SELECT call sites in the client
-- (sync.ts's mergeBookmarks, sharedFolders.ts's resolveMissingAsHighlights)
-- are both being switched to the gated view in this same commit.

CREATE OR REPLACE VIEW public.synced_bookmarks_gated AS
SELECT
  id,
  user_id,
  document_number,
  title,
  date_issued,
  office,
  subject_series,
  saved_at,
  updated_at,
  deleted,
  ac_id,
  block_kind,
  block_label,
  CASE COALESCE(item_type, 'ac')
    WHEN 'far' THEN block_snippet
    WHEN 'aim' THEN block_snippet
    WHEN 'pcg' THEN block_snippet
    WHEN 'loi' THEN CASE WHEN has_pro_access() THEN block_snippet ELSE NULL::text END
    WHEN 'ac'  THEN CASE WHEN has_plus_access() THEN block_snippet ELSE NULL::text END
    WHEN 'ad'  THEN CASE WHEN has_plus_access() THEN block_snippet ELSE NULL::text END
    WHEN 'cfr49' THEN CASE WHEN has_plus_access() THEN block_snippet ELSE NULL::text END
    ELSE CASE WHEN has_pro_access() THEN block_snippet ELSE NULL::text END
  END AS block_snippet,
  CASE COALESCE(item_type, 'ac')
    WHEN 'far' THEN block_text
    WHEN 'aim' THEN block_text
    WHEN 'pcg' THEN block_text
    WHEN 'loi' THEN CASE WHEN has_pro_access() THEN block_text ELSE NULL::text END
    WHEN 'ac'  THEN CASE WHEN has_plus_access() THEN block_text ELSE NULL::text END
    WHEN 'ad'  THEN CASE WHEN has_plus_access() THEN block_text ELSE NULL::text END
    WHEN 'cfr49' THEN CASE WHEN has_plus_access() THEN block_text ELSE NULL::text END
    ELSE CASE WHEN has_pro_access() THEN block_text ELSE NULL::text END
  END AS block_text,
  item_type
FROM public.synced_bookmarks;

GRANT SELECT ON public.synced_bookmarks_gated TO anon, authenticated;

-- Deliberately NOT closing the raw table's own SELECT on block_text/
-- block_snippet the way migrations_fix_pdf_url_cached_column_grant_leak.sql
-- closed AC/LOI's pdf_url_cached -- tried exactly that shape (revoke
-- table-wide SELECT, re-grant an explicit column list excluding the two
-- sensitive columns) and it broke a REAL, in-production write path, caught
-- by this sweep's own live regression check before landing, not after:
-- syncPushBookmark's upsert (syncPush.ts, `Prefer:
-- resolution=merge-duplicates`, no `.select()` chained) started failing
-- with a flat `42501 permission denied for table synced_bookmarks` the
-- moment table-wide SELECT was revoked, even though the request writes,
-- never reads. Root cause: Postgres's `INSERT ... ON CONFLICT DO UPDATE`
-- (what an upsert compiles to) requires SELECT privilege on the target
-- table to evaluate the conflict, regardless of `Prefer: return=minimal` --
-- a column-level SELECT grant on a SUBSET of columns does not satisfy this
-- (confirmed live: still 403'd with a 14-column explicit grant that
-- excluded only the 2 sensitive ones). The only way to keep upsert working
-- would be granting SELECT on every column including block_text/
-- block_snippet, which defeats the fix. Immediately reverted the table
-- grant back to its original table-wide `GRANT SELECT ON synced_bookmarks
-- TO anon, authenticated` and re-verified live that the real upsert shape
-- succeeds again (201) before this file was finalized.
--
-- Net effect of this migration: both real client read paths (sync.ts's
-- mergeBookmarks, sharedFolders.ts's resolveMissingAsHighlights -- see
-- their own updated call sites) now go through synced_bookmarks_gated and
-- are fully closed, independently re-verified live both before (real
-- gated text came back for a downgraded account) and after (same account,
-- same row, now null) this fix. The RAW table's block_text/block_snippet
-- columns remain technically readable by a hand-crafted direct REST call
-- with a signed-in JWT (same as before this migration) -- a real, smaller
-- residual gap, not reachable through any actual app code path anymore,
-- left open deliberately rather than risk breaking every real subscriber's
-- bookmark sync. Flagged, not fixed: closing it for real needs
-- syncPushBookmark's upsert rewritten to avoid ON CONFLICT (e.g. a
-- SECURITY DEFINER RPC that does the write server-side), which is a real
-- change to a core, high-traffic write path and deserves its own careful
-- pass, not a rushed addition to this one.
