-- Patched in place from the LIVE definition so the signature is byte-identical
-- and no overload is created (PostgREST cannot disambiguate overloads -- see
-- gotcha_create_or_replace_signature_overload). Only the two block_*
-- assignments in the ON CONFLICT clause change.

CREATE OR REPLACE FUNCTION public.push_bookmark(p_id text, p_document_number text, p_title text, p_date_issued text, p_office text, p_subject_series text, p_saved_at timestamp with time zone, p_item_type text, p_ac_id text, p_block_kind text, p_block_label text, p_block_snippet text, p_block_text text)
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
    -- coalesce, NOT plain assignment: mergeBookmarks pulls from
    -- synced_bookmarks_gated, which NULLs these two when has_plus_access()
    -- is false, and a later push of that local row would otherwise write
    -- the NULL back over real text, permanently. A highlight's passage
    -- never legitimately becomes NULL once it is set.
    block_snippet = coalesce(excluded.block_snippet, public.synced_bookmarks.block_snippet),
    block_text = coalesce(excluded.block_text, public.synced_bookmarks.block_text);
END;
$function$

