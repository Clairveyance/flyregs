-- ============================================================================
-- SECURITY (HIGH): synced_bookmarks_gated exposes EVERY user's bookmarks and
-- highlights to any caller holding the public anon key      2026-08-30
-- ============================================================================
--
-- NOT YET APPLIED. Found during the shared-folder bug sweep; written for the
-- calling session to review and apply, per the standing "sweep agents are
-- never destructive" rule. This one is worth applying promptly.
--
-- WHAT
-- ----
-- public.synced_bookmarks_gated is a plain view over public.synced_bookmarks.
-- synced_bookmarks itself is correctly locked down: relrowsecurity = true,
-- four sensible policies (users_manage_own_synced_bookmarks,
-- collaborators_read_shared_bookmarks, owners_manage_shared_bookmarks,
-- editors_manage_shared_bookmarks), and NO select grant to anon or
-- authenticated at all (confirmed: information_schema.role_table_grants shows
-- only REFERENCES/TRIGGER for those roles).
--
-- The view undoes all of it:
--   * it is owned by `postgres`, which also owns synced_bookmarks;
--   * synced_bookmarks has relforcerowsecurity = false, so RLS does not apply
--     to the table owner;
--   * the view has no reloptions, i.e. security_invoker is OFF, so it
--     executes as its owner;
--   * SELECT on the view is granted to BOTH anon and authenticated;
--   * and the view body has no row filter of any kind -- only per-tier
--     redaction of block_text/block_snippet, which gates by the CALLER'S OWN
--     subscription tier, never by who owns the row.
--
-- Net effect: any caller with the app's public anon key can read every
-- FlyRegs user's entire bookmark and highlight list. Proven live, 2026-08-30,
-- with an UNAUTHENTICATED request (anon key only, no session):
--
--   GET /rest/v1/synced_bookmarks_gated?select=id,user_id,document_number&limit=3
--   -> 200 [{"id":"46e2399d-...-hl-1784504242530-lmug1r",
--            "user_id":"bb05dcdc-...","document_number":"00-1.1B"},
--           {"id":"91.17","user_id":"292ea333-...","document_number":"§ 91.17"},
--           {"id":"61.113","user_id":"292ea333-...","document_number":"§ 61.113"}]
--
-- (The same request against the base table correctly 401s: "permission denied
-- for table synced_bookmarks".) Rows from two different real accounts came
-- back to a caller with no session at all.
--
-- This is the same class of bug as migrations_close_public_schema_default_
-- privileges.sql and the quizzable_* leaks -- a gated VIEW added to keep
-- callers off a locked-down table, which then became the way around it.
-- Every other *_gated view in this schema is over PUBLIC reference content
-- (advisory_circulars, far/aim/pcg/loi/cfr49, dictionary, study_facts), where
-- owner-rights execution is harmless. synced_bookmarks_gated is the only one
-- over per-user private data -- checked all 16 views in `public`.
--
-- FIX
-- ---
-- Deliberately NOT `security_invoker = true`: that would require granting
-- authenticated a direct SELECT on synced_bookmarks, which is exactly what
-- migrations_synced_bookmarks_write_rpc.sql revoked (and why push_bookmark /
-- soft_delete_bookmarks exist at all). Instead, put the row filter INSIDE the
-- view, mirroring ALL THREE of the base table's read-capable policies:
--
--   users_manage_own_synced_bookmarks     -> user_id = auth.uid()
--   collaborators_read_shared_bookmarks   -> reachable via a non-note
--                                            synced_folder_items pointer in a
--                                            folder has_folder_access() grants
--   owners_manage_shared_bookmarks        -> reachable via a pointer in a
--                                            folder THIS user OWNS
--
-- (editors_manage_shared_bookmarks needs no separate arm: its
-- has_folder_access(folder_id, true) is strictly narrower than the
-- collaborator arm's has_folder_access(folder_id).)
--
-- The OWNER arm is not optional and is easy to miss -- a folder's owner has
-- NO folder_collaborators row for their own folder, so has_folder_access()
-- is false for them and the first two arms alone would hide a
-- collaborator-authored highlight from the owner. That is not a cosmetic
-- gap: folder/[id].tsx's loadLocal() treats an item that resolves neither
-- locally NOR remotely as genuinely orphaned and SELF-HEAL-DELETES it, for
-- everyone, on the server. Getting this arm wrong would turn a read
-- restriction into silent data loss -- the exact "items just disappeared"
-- class of bug (feedback 3977e7d4) this whole area has already been burned
-- by once.
--
-- has_folder_access() and folder_owner_id() are both SECURITY DEFINER, so
-- shared-folder highlight resolution (resolveMissingAsHighlights in
-- src/lib/sharedFolders.ts, the ONLY way either side can render a highlight)
-- keeps working in BOTH directions. An anon caller has auth.uid() = null,
-- no folder access and owns nothing, so it now returns zero rows rather
-- than everything.
--
-- The per-tier redaction below is copied VERBATIM from the current live
-- definition (pg_get_viewdef, 2026-08-30) -- this migration changes exactly
-- one thing, the added WHERE clause. Do not "tidy" the CASE arms; they encode
-- the real per-content-type gate (see migrations_fix_synced_bookmarks_
-- highlight_gate_leak.sql).
-- ============================================================================

create or replace view public.synced_bookmarks_gated as
 SELECT id,
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
        CASE COALESCE(item_type, 'ac'::text)
            WHEN 'far'::text THEN block_snippet
            WHEN 'aim'::text THEN block_snippet
            WHEN 'pcg'::text THEN block_snippet
            WHEN 'loi'::text THEN
            CASE
                WHEN has_pro_access() THEN block_snippet
                ELSE NULL::text
            END
            WHEN 'ac'::text THEN
            CASE
                WHEN has_plus_access() THEN block_snippet
                ELSE NULL::text
            END
            WHEN 'ad'::text THEN
            CASE
                WHEN has_plus_access() THEN block_snippet
                ELSE NULL::text
            END
            WHEN 'cfr49'::text THEN
            CASE
                WHEN has_plus_access() THEN block_snippet
                ELSE NULL::text
            END
            ELSE
            CASE
                WHEN has_pro_access() THEN block_snippet
                ELSE NULL::text
            END
        END AS block_snippet,
        CASE COALESCE(item_type, 'ac'::text)
            WHEN 'far'::text THEN block_text
            WHEN 'aim'::text THEN block_text
            WHEN 'pcg'::text THEN block_text
            WHEN 'loi'::text THEN
            CASE
                WHEN has_pro_access() THEN block_text
                ELSE NULL::text
            END
            WHEN 'ac'::text THEN
            CASE
                WHEN has_plus_access() THEN block_text
                ELSE NULL::text
            END
            WHEN 'ad'::text THEN
            CASE
                WHEN has_plus_access() THEN block_text
                ELSE NULL::text
            END
            WHEN 'cfr49'::text THEN
            CASE
                WHEN has_plus_access() THEN block_text
                ELSE NULL::text
            END
            ELSE
            CASE
                WHEN has_pro_access() THEN block_text
                ELSE NULL::text
            END
        END AS block_text,
    item_type
   FROM synced_bookmarks
  WHERE user_id = auth.uid()
     OR EXISTS (
          SELECT 1
          FROM synced_folder_items sfi
          WHERE sfi.item_type <> 'note'::text
            AND sfi.item_id = synced_bookmarks.id
            AND sfi.deleted = false
            AND (has_folder_access(sfi.folder_id)
                 OR folder_owner_id(sfi.folder_id) = auth.uid())
        );

-- anon can never satisfy either arm (auth.uid() is null, has_folder_access
-- is false), so this grant is now inert -- revoked anyway so the view's
-- reachable audience matches its actual purpose, and so a future edit to the
-- WHERE clause can't silently re-open an unauthenticated path.
revoke select on public.synced_bookmarks_gated from anon;

-- VERIFY AFTER APPLYING (all three, in order):
--  1. Unauthenticated, anon key only -- must now return []:
--       GET /rest/v1/synced_bookmarks_gated?select=id,user_id&limit=3
--  2. As a real signed-in user -- must return THEIR OWN bookmarks, and only
--     those plus any reachable through a folder they've joined.
--  3. Shared-folder highlights still render in BOTH directions -- this is
--     the check that matters most, because a false negative here becomes a
--     self-heal delete, not just a blank row:
--       a. as the COLLABORATOR, open a folder the OWNER filled with a
--          highlight (folder/shared/[id].tsx -> resolveMissingAsHighlights);
--       b. as the OWNER, open a folder a COLLABORATOR filed a highlight into
--          (folder/[id].tsx -> resolveForeignFolderEntries).
--     Both must show the highlight with its passage text.
--     `python3 scripts/shared_folder_invite_e2e_test.py` covers exactly this
--     and is the fastest way to confirm it -- its two standing SECURITY
--     failures should flip to PASS once this migration is applied, with
--     every other check still passing.
