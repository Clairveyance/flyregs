-- Close the synced_bookmarks residual read gap: move the write off raw
-- table access entirely   2026-08-24
--
-- Flagged, deliberately not rushed, by migrations_fix_synced_bookmarks_
-- highlight_gate_leak.sql (today, earlier): closing both real client READ
-- paths (sync.ts, sharedFolders.ts -- switched to synced_bookmarks_gated)
-- fixed the actual live leak, but a raw table-level SELECT grant on
-- block_text/block_snippet had to stay in place for anon/authenticated,
-- because syncPushBookmark's real, in-production upsert
-- (INSERT ... ON CONFLICT DO UPDATE) needs table-level SELECT to evaluate
-- the conflict -- confirmed live at the time: a column-subset re-grant
-- still 403'd the real write. That migration's own comment named the real
-- fix -- move the write off ON CONFLICT into a SECURITY DEFINER RPC -- and
-- explicitly deferred it as "a real change to a core, high-traffic write
-- path, deserves its own careful pass."
--
-- This is that pass. push_bookmark() performs the identical upsert
-- SECURITY DEFINER (bypasses RLS/grants for its own internal write,
-- exactly like every other SECURITY DEFINER function in this schema --
-- e.g. get_next_challenge_question), and takes user_id from auth.uid()
-- internally, never as a parameter -- a caller can only ever write under
-- their own identity, matching the RLS policy it replaces exactly.
--
-- With the write no longer needing table SELECT at all (only EXECUTE on
-- this function), synced_bookmarks' direct table-level SELECT grant for
-- anon/authenticated is revoked entirely -- confirmed safe first:
-- synced_bookmarks_gated has security_invoker unset (Postgres default
-- false, confirmed live via pg_class.reloptions), meaning it runs with the
-- VIEW OWNER's privileges, not the querying role's -- revoking the raw
-- table grant does not affect the gated view at all. syncPushBookmarkDeletes
-- (a plain UPDATE, no ON CONFLICT) was never affected by any of this --
-- UPDATE only needs UPDATE privilege + a satisfying RLS row, no SELECT
-- special case -- so it's untouched, still works via the existing RLS
-- policy directly.
--
-- Net effect: the raw table's block_text/block_snippet are no longer
-- reachable by ANY caller with just an authenticated JWT, hand-crafted API
-- call or not -- the only two paths left are the SECURITY DEFINER RPC
-- (write, no read) and the _gated view (read, tier-redacted). This closes
-- the residual gap that migration explicitly left open.

CREATE OR REPLACE FUNCTION public.push_bookmark(
  p_id text,
  p_document_number text,
  p_title text,
  p_date_issued text,
  p_office text,
  p_subject_series text,
  p_saved_at timestamptz,
  p_item_type text,
  p_ac_id text,
  p_block_kind text,
  p_block_label text,
  p_block_snippet text,
  p_block_text text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.synced_bookmarks (
    id, user_id, document_number, title, date_issued, office, subject_series,
    saved_at, updated_at, deleted, item_type, ac_id, block_kind, block_label,
    block_snippet, block_text
  )
  VALUES (
    p_id, auth.uid(), p_document_number, p_title, p_date_issued, p_office, p_subject_series,
    p_saved_at, now(), false, p_item_type, p_ac_id, p_block_kind, p_block_label,
    p_block_snippet, p_block_text
  )
  ON CONFLICT (user_id, id) DO UPDATE SET
    document_number = excluded.document_number,
    title = excluded.title,
    date_issued = excluded.date_issued,
    office = excluded.office,
    subject_series = excluded.subject_series,
    saved_at = excluded.saved_at,
    updated_at = excluded.updated_at,
    deleted = false,
    item_type = excluded.item_type,
    ac_id = excluded.ac_id,
    block_kind = excluded.block_kind,
    block_label = excluded.block_label,
    block_snippet = excluded.block_snippet,
    block_text = excluded.block_text;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.push_bookmark(text, text, text, text, text, text, timestamptz, text, text, text, text, text, text) TO authenticated;

-- syncPushBookmarkDeletes' plain `UPDATE ... WHERE user_id=x AND id IN (...)`
-- (no ON CONFLICT) was assumed above to need only UPDATE privilege, not
-- SELECT -- WRONG, disproven by live-testing this migration before
-- finalizing it (same live-regression-check standard as the earlier
-- highlight-gate-leak fix): PostgREST's PATCH also 403'd once table SELECT
-- was revoked. Same fix, same shape as push_bookmark above.
CREATE OR REPLACE FUNCTION public.soft_delete_bookmarks(p_ids text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.synced_bookmarks
  SET deleted = true, updated_at = now()
  WHERE user_id = auth.uid() AND id = ANY(p_ids);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.soft_delete_bookmarks(text[]) TO authenticated;

REVOKE SELECT ON public.synced_bookmarks FROM anon, authenticated;
