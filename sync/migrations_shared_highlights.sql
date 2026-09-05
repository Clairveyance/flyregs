-- See other participants' highlights inside a shared folder's documents.
--
-- RC, "Suggest a feature", 2026-09-05:
--   "if the folder is read only then the owner can add highlights. If the
--    folder is read/write access between the participants then everybody who
--    has read/write access must be able to both see the other person's added
--    highlights even after the folder has been shared. People should be able
--    to add new highlights that everybody can see, and with read/write access
--    all participants who have it should be able to edit add delete and change
--    any highlights."
--
-- WHAT WAS ACTUALLY WRONG -- measured, not assumed.
-- scripts/shared_folder_highlights_e2e_test.py drives this whole rule against
-- the live database with real user JWTs, and every server-side clause of it
-- ALREADY PASSED before this migration: a read-only collaborator can see the
-- owner's highlight and cannot add or edit one; a read/write collaborator can
-- add their own, the owner sees it, and either can edit the other's; revoking
-- read/write stops edits immediately; leaving stops reads; losing Premium
-- stops access. The RLS on synced_bookmarks was already correct.
--
-- The gap is on the CLIENT, and it is total: getHighlightsForAC() in
-- src/lib/bookmarks.ts reads the local AsyncStorage bookmark list and nothing
-- else. A document screen has therefore only ever been able to show YOUR OWN
-- highlights. Another participant's highlight existed, synced, and was
-- readable -- and no screen ever asked for it.
--
-- This RPC is the missing question. It deliberately returns the two things a
-- screen needs and cannot work out for itself: the highlighted passage, and
-- whether this viewer is allowed to change it.

begin;

create or replace function public.get_shared_highlights(
  p_item_type text,
  p_ac_id     text
) returns table(
  id            text,
  owner_id      uuid,
  owner_label   text,
  block_kind    text,
  block_label   text,
  block_snippet text,
  block_text    text,
  can_edit      boolean
)
language sql
stable
security invoker          -- RLS on synced_bookmarks IS the gate; see below
set search_path to 'public', 'pg_temp'
as $$
  -- SECURITY INVOKER on purpose. collaborators_read_shared_bookmarks /
  -- editors_manage_shared_bookmarks / owners_manage_shared_bookmarks already
  -- express exactly who may see which highlight, and they are covered by
  -- scripts/shared_folder_highlights_e2e_test.py. A SECURITY DEFINER function
  -- would have to restate that logic and could then disagree with it -- the
  -- precise failure that let user_duel_stats leak every player's record while
  -- its RPC looked correct (see migrations_gate_user_duel_stats_rls.sql).
  -- Running as the caller means there is one rule, in one place.
  --
  -- The consequence, found by running it rather than by reasoning: an invoker
  -- function cannot read auth.users ("permission denied for table users").
  -- So the display label comes from callsign_registry alone, which is already
  -- the app's public identity table (Find Friends reads it the same way), and
  -- falls back to a neutral word rather than reaching for user metadata.
  select distinct on (sb.id)
    sb.id,
    sb.user_id as owner_id,
    coalesce(cr.callsign, 'A collaborator') as owner_label,
    sb.block_kind,
    sb.block_label,
    sb.block_snippet,
    sb.block_text,
    -- Editable when this viewer owns the folder the highlight sits in, or has
    -- read_write on it. Mirrors owners_manage_shared_bookmarks /
    -- editors_manage_shared_bookmarks so the UI cannot offer an action the
    -- database will refuse. A highlight can sit in more than one folder, so
    -- this is bool_or ACROSS those folders: write access anywhere is write
    -- access to the highlight, which is what the policies themselves say.
    bool_or(folder_owner_id(sfi.folder_id) = auth.uid() or has_folder_access(sfi.folder_id, true))
      over (partition by sb.id) as can_edit
  from synced_bookmarks sb
  join synced_folder_items sfi
    on sfi.item_id = sb.id and sfi.item_type <> 'note' and sfi.deleted = false
  left join callsign_registry cr on cr.user_id = sb.user_id
  where sb.deleted = false
    and sb.block_text is not null
    and sb.ac_id = p_ac_id
    and sb.item_type = p_item_type
    -- Someone ELSE's. The caller's own highlights come from local storage and
    -- are already on screen; returning them here would double-render every one
    -- of them and make "is this mine?" ambiguous at exactly the moment the
    -- screen has to decide whether tapping removes it.
    and sb.user_id <> auth.uid()
  -- DISTINCT ON needs a leading ORDER BY on the same expression, and picking
  -- the can_edit = true row makes the choice deterministic rather than
  -- whichever folder the planner happened to reach first.
  order by sb.id, can_edit desc;
$$;

grant execute on function public.get_shared_highlights(text, text) to authenticated;
revoke execute on function public.get_shared_highlights(text, text) from anon, public;

commit;
