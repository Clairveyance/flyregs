-- ============================================================================
-- SECURITY (CRITICAL): a self-owned folder pointer grants ALL over a
-- STRANGER's synced_notes row -- read, overwrite, and HARD DELETE  2026-08-31
-- ============================================================================
--
-- NOT YET APPLIED. Written during the C1-C5 sync/data-loss re-audit for RC to
-- review and apply, per the standing "audit agents never write to the live
-- DB" rule. Proven live first -- see
-- scripts/sync_cross_account_destruction_test.py, which reproduces every
-- claim below end-to-end with two real disposable accounts and real JWTs.
--
-- WHAT
-- ----
-- Four cross-folder RLS predicates reach a row purely by
--
--     synced_folder_items.item_id = <row>.id
--
-- with NO requirement that the row's OWNER has anything to do with that
-- folder. The folder-side half of each predicate is correctly scoped (I own
-- the folder / I am an editor on it) -- but folder ownership was being used
-- as a stand-in for item ownership, which it is not:
--
--   synced_notes.owners_manage_shared_notes        (ALL)
--   synced_notes.editors_manage_shared_notes       (ALL)
--   synced_notes.collaborators_read_shared_notes   (SELECT)
--   synced_bookmarks_gated's own WHERE clause      (the view is
--       security-definer-style -- see
--       migrations_fix_synced_bookmarks_gated_rls_bypass.sql -- so that
--       WHERE is the ONLY row filter standing in front of the whole table)
--
-- plus the same shape, currently unreachable, on
-- synced_bookmarks.owners_manage_shared_bookmarks /
-- .editors_manage_shared_bookmarks / .collaborators_read_shared_bookmarks.
-- Those three are latent only because `authenticated` holds no
-- INSERT/UPDATE/DELETE/SELECT grant on synced_bookmarks at all (only
-- REFERENCES/TRIGGER) -- one restored grant, exactly like
-- migrations_restore_synced_bookmarks_grant_emergency.sql once did, and they
-- become live mass-destruction policies. Fixed here too rather than left as a
-- landmine.
--
-- Nothing stops the pointer being created: enforce_folder_item_access, the
-- BEFORE INSERT trigger on synced_folder_items, validates only NEW.folder_id.
-- It never looks at NEW.item_id, so any Pro user can insert
-- {folder_id: <a folder I own>, item_type: 'note', item_id: <anyone's id>}
-- into their own private folder and thereby acquire owners_manage_shared_
-- notes' ALL grant over that stranger's row.
--
-- PROVEN LIVE, 2026-08-31 (attacker and victim both disposable accounts, the
-- note never shared with anyone and never placed in any shared folder):
--
--   PASS  BASELINE: attacker cannot SELECT the victim's note
--   PASS  BASELINE: attacker's UPDATE of the victim's note affects 0 rows
--   PASS  attacker CAN point their own folder at a stranger's note id
--   FAIL  ATTACK: attacker still CANNOT read the victim's note
--         -> got {'title': 'Victim private note', 'body': 'ORIGINAL VICTIM BODY'}
--   FAIL  ATTACK: the victim's note body is UNCHANGED after the attacker's UPDATE
--         -> row now reads 'OVERWRITTEN BY ATTACKER'
--   FAIL  ATTACK: the victim's note row still EXISTS after the attacker's DELETE
--         -> HARD DELETE, the victim's row is gone from the table
--   FAIL  ATTACK: attacker still CANNOT read the victim's bookmark row
--         -> got another user's row incl. block_text 'VICTIM SECRET HIGHLIGHT TEXT'
--
-- WHY THE BOOKMARK HALF IS THE MASS CASE
-- --------------------------------------
-- A note id is a random makeNoteId() -- not enumerable, so the practical
-- attacker there is an EX-COLLABORATOR who legitimately saw the id while in a
-- shared folder and simply remembers it: removing them revokes
-- has_folder_access and therefore editors_manage_shared_notes, but they
-- re-acquire the identical reach through owners_manage_shared_notes by
-- pointing their OWN folder at the remembered id, permanently and invisibly.
--
-- A whole-doc bookmark's id IS the document's own public id (bookmarks.ts:
-- "a whole-doc bookmark, where id === acId"), identical for every user who
-- bookmarked that document. So `?id=eq.<any AC/FAR/AIM id>` against
-- synced_bookmarks_gated, after one folder-item insert, returns EVERY user's
-- row for that document -- their user_id, what they bookmarked, and their
-- verbatim highlight text. Same blast radius as the 2026-08-30
-- synced_bookmarks_gated incident (c564e4f), reopened through a different
-- door: that fix added a row filter, and this is a hole IN that row filter.
--
-- THE FIX
-- -------
-- Three independent layers, because any one of them alone can be walked
-- around:
--
--   1. is_folder_participant(folder, user) -- the missing half of every
--      predicate above. The row's OWNER must actually be the folder's owner
--      or an ACCEPTED collaborator on it. Preserves every legitimate case
--      (a collaborator's note/bookmark sitting in the owner's folder, and
--      the owner's own items visible to an editor) and blocks the stranger.
--      Deliberately does NOT require `left_at is null`: a folder owner should
--      still be able to manage what a collaborator left behind in their
--      folder. It DOES require accepted_at, so a bare uninvited/unaccepted
--      invite grants nothing.
--
--   2. enforce_folder_item_access also pins NEW.user_id = auth.uid().
--      Without this, layer 1 could be walked around from the other side:
--      owners_synced_folder_items_insert's WITH CHECK constrains only
--      folder_id, so a client can already POST a folder_item attributed to an
--      arbitrary user_id. Every real call site (syncPush.ts's folderItemRow)
--      passes the caller's own id, so nothing legitimate changes. Skipped for
--      non-authenticated/anon roles so SECURITY DEFINER RPCs and service-role
--      backfills are unaffected -- same escape hatch
--      guard_folder_collaborator_self_update already uses.
--
--   3. guard_folder_collaborator_self_update stops treating the folder OWNER
--      as unrestricted. It currently returns NEW unconditionally when
--      auth.uid() = old.owner_id, and owners_update_collaborator_mode grants
--      that owner a real UPDATE on the row -- so an attacker could
--      invite_folder_collaborator(their folder, victim's callsign) and then
--      simply PATCH accepted_at themselves, forging layer 1's consent signal
--      without the victim ever touching anything. The owner now gets the same
--      treatment collaborators already get: a named allowlist of columns.
--      collab_mode and left_at are the only two the client ever writes as
--      owner (sharedFolders.ts setCollaboratorMode / removeCollaborator).
--
-- ORDER OF OPERATIONS
-- -------------------
-- Layers 2 and 3 are pure tightenings and safe to apply first. Layer 1
-- changes read/write visibility for shared folders -- exercise
-- scripts/shared_folder_invite_e2e_test.py, scripts/folders_e2e_test.py and
-- scripts/folder_collaborator_downgrade_test.py after applying, then
-- scripts/sync_cross_account_destruction_test.py, which must go from 4
-- failures to ALL PASSED.
-- ============================================================================

begin;

-- ── layer 1: the missing ownership half ─────────────────────────────────────
create or replace function public.is_folder_participant(p_folder_id text, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null and (
    exists (
      select 1 from synced_folders sf
      where sf.id = p_folder_id and sf.user_id = p_user_id
    )
    or exists (
      select 1 from folder_collaborators fc
      where fc.folder_id = p_folder_id
        and fc.user_id = p_user_id
        and fc.accepted_at is not null
    )
  );
$$;

grant execute on function public.is_folder_participant(text, uuid) to anon, authenticated;

-- synced_notes
drop policy if exists owners_manage_shared_notes on public.synced_notes;
create policy owners_manage_shared_notes on public.synced_notes
  for all
  using (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type = 'note'
        and sfi.item_id = synced_notes.id
        and sfi.deleted = false
        and folder_owner_id(sfi.folder_id) = auth.uid()
        and is_folder_participant(sfi.folder_id, synced_notes.user_id)
    )
  )
  with check (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type = 'note'
        and sfi.item_id = synced_notes.id
        and sfi.deleted = false
        and folder_owner_id(sfi.folder_id) = auth.uid()
        and is_folder_participant(sfi.folder_id, synced_notes.user_id)
    )
  );

drop policy if exists editors_manage_shared_notes on public.synced_notes;
create policy editors_manage_shared_notes on public.synced_notes
  for all
  using (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type = 'note'
        and sfi.item_id = synced_notes.id
        and sfi.deleted = false
        and has_folder_access(sfi.folder_id, true)
        and is_folder_participant(sfi.folder_id, synced_notes.user_id)
    )
  )
  with check (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type = 'note'
        and sfi.item_id = synced_notes.id
        and sfi.deleted = false
        and has_folder_access(sfi.folder_id, true)
        and is_folder_participant(sfi.folder_id, synced_notes.user_id)
    )
  );

drop policy if exists collaborators_read_shared_notes on public.synced_notes;
create policy collaborators_read_shared_notes on public.synced_notes
  for select
  using (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type = 'note'
        and sfi.item_id = synced_notes.id
        and sfi.deleted = false
        and has_folder_access(sfi.folder_id)
        and is_folder_participant(sfi.folder_id, synced_notes.user_id)
    )
  );

-- synced_bookmarks (currently unreachable -- no table grant for anon or
-- authenticated -- but the same shape, so fixed rather than left as a
-- landmine for the next grant restore)
drop policy if exists owners_manage_shared_bookmarks on public.synced_bookmarks;
create policy owners_manage_shared_bookmarks on public.synced_bookmarks
  for all
  using (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type <> 'note'
        and sfi.item_id = synced_bookmarks.id
        and sfi.deleted = false
        and folder_owner_id(sfi.folder_id) = auth.uid()
        and is_folder_participant(sfi.folder_id, synced_bookmarks.user_id)
    )
  )
  with check (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type <> 'note'
        and sfi.item_id = synced_bookmarks.id
        and sfi.deleted = false
        and folder_owner_id(sfi.folder_id) = auth.uid()
        and is_folder_participant(sfi.folder_id, synced_bookmarks.user_id)
    )
  );

drop policy if exists editors_manage_shared_bookmarks on public.synced_bookmarks;
create policy editors_manage_shared_bookmarks on public.synced_bookmarks
  for all
  using (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type <> 'note'
        and sfi.item_id = synced_bookmarks.id
        and sfi.deleted = false
        and has_folder_access(sfi.folder_id, true)
        and is_folder_participant(sfi.folder_id, synced_bookmarks.user_id)
    )
  )
  with check (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type <> 'note'
        and sfi.item_id = synced_bookmarks.id
        and sfi.deleted = false
        and has_folder_access(sfi.folder_id, true)
        and is_folder_participant(sfi.folder_id, synced_bookmarks.user_id)
    )
  );

drop policy if exists collaborators_read_shared_bookmarks on public.synced_bookmarks;
create policy collaborators_read_shared_bookmarks on public.synced_bookmarks
  for select
  using (
    exists (
      select 1 from synced_folder_items sfi
      where sfi.item_type <> 'note'
        and sfi.item_id = synced_bookmarks.id
        and sfi.deleted = false
        and has_folder_access(sfi.folder_id)
        and is_folder_participant(sfi.folder_id, synced_bookmarks.user_id)
    )
  );

-- synced_bookmarks_gated: identical column list and per-tier redaction as
-- today (unchanged, reproduced verbatim from pg_get_viewdef) -- ONLY the
-- final WHERE gains the is_folder_participant half. CREATE OR REPLACE VIEW
-- keeps the existing grants.
create or replace view public.synced_bookmarks_gated as
 select id,
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
        case coalesce(item_type, 'ac'::text)
            when 'far'::text then block_snippet
            when 'aim'::text then block_snippet
            when 'pcg'::text then block_snippet
            when 'loi'::text then case when has_pro_access() then block_snippet else null::text end
            when 'ac'::text then case when has_plus_access() then block_snippet else null::text end
            when 'ad'::text then case when has_plus_access() then block_snippet else null::text end
            when 'cfr49'::text then case when has_plus_access() then block_snippet else null::text end
            else case when has_pro_access() then block_snippet else null::text end
        end as block_snippet,
        case coalesce(item_type, 'ac'::text)
            when 'far'::text then block_text
            when 'aim'::text then block_text
            when 'pcg'::text then block_text
            when 'loi'::text then case when has_pro_access() then block_text else null::text end
            when 'ac'::text then case when has_plus_access() then block_text else null::text end
            when 'ad'::text then case when has_plus_access() then block_text else null::text end
            when 'cfr49'::text then case when has_plus_access() then block_text else null::text end
            else case when has_pro_access() then block_text else null::text end
        end as block_text,
    item_type
   from synced_bookmarks
  where user_id = auth.uid()
     or (exists (
           select 1
           from synced_folder_items sfi
          where sfi.item_type <> 'note'::text
            and sfi.item_id = synced_bookmarks.id
            and sfi.deleted = false
            and (has_folder_access(sfi.folder_id) or folder_owner_id(sfi.folder_id) = auth.uid())
            and is_folder_participant(sfi.folder_id, synced_bookmarks.user_id)
        ));

-- ── layer 2: a folder_item may only be attributed to its inserter ───────────
create or replace function public.enforce_folder_item_access()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
BEGIN
  -- Service role / SECURITY DEFINER callers are exempt, same escape hatch
  -- guard_folder_collaborator_self_update uses.
  IF current_user IN ('authenticated', 'anon') AND NEW.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'A folder item may only be attributed to the account inserting it';
  END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM synced_folders sf WHERE sf.id = NEW.folder_id AND sf.user_id = auth.uid() AND public.has_pro_access(sf.user_id))
    OR public.has_folder_access(NEW.folder_id, true)
  ) THEN
    RAISE EXCEPTION 'You do not have write access to this folder';
  END IF;
  RETURN NEW;
END;
$$;

-- ── layer 3: a folder owner cannot forge a collaborator's acceptance ────────
create or replace function public.guard_folder_collaborator_self_update()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if auth.uid() = old.owner_id then
    -- The OWNER may change only what sharedFolders.ts actually writes as
    -- owner: collab_mode (setCollaboratorMode) and left_at
    -- (removeCollaborator). Everything else -- above all accepted_at, which
    -- is_folder_participant now trusts as the invitee's own consent signal --
    -- belongs to the invitee or to the SECURITY DEFINER invite/join RPCs,
    -- which are exempt via the current_user check above.
    if new.folder_id is distinct from old.folder_id
       or new.owner_id is distinct from old.owner_id
       or new.user_id is distinct from old.user_id
       or new.invite_token is distinct from old.invite_token
       or new.accepted_at is distinct from old.accepted_at
       or new.joined_at is distinct from old.joined_at
    then
      raise exception 'A folder owner may only change collab_mode or left_at on a collaborator row';
    end if;
    return new;
  end if;
  if new.folder_id is distinct from old.folder_id
     or new.owner_id is distinct from old.owner_id
     or new.user_id is distinct from old.user_id
     or new.collab_mode is distinct from old.collab_mode
     or new.invite_token is distinct from old.invite_token
     or new.accepted_at is distinct from old.accepted_at
     or new.joined_at is distinct from old.joined_at
     or (new.left_at is distinct from old.left_at and not (old.left_at is null and new.left_at is not null))
  then
    raise exception 'Only last_viewed_at, or leaving (left_at null -> set), may be self-updated by a collaborator';
  end if;
  return new;
end;
$$;

commit;
