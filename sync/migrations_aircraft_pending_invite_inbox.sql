-- ============================================================================
-- Aircraft sharing: let an invitee SEE a pending Callsign invite in the app
--                                                              2026-08-30
-- ============================================================================
--
-- NOT YET APPLIED. Written by an investigation pass under this project's
-- standing "sweep agents are never destructive" rule -- review and apply
-- from the calling session.
--
-- WHY
-- ---
-- RC, real device, live testing session with a second real account
-- (Adriana): "Even if a person is somehow able to send an invite in the
-- Aircraft section the invite never comes to the intended recipient. Not
-- through call sign, not through a text message, nothing. Again this entire
-- feature is completely broken and needs a 100% from the ground up
-- investigation and fix."
--
-- This is the exact same bug class as tonight's folder-sharing fix (see
-- sync/migrations_folder_pending_invite_inbox.sql, applied earlier this
-- session) -- just never caught here, since aircraft sharing is a separate
-- code path (src/lib/aircraftSharing.ts, not sharedFolders.ts) that happens
-- to share the identical Callsign-invite architecture:
--
--   * The only delivery channel invite_aircraft_collaborator() ever gets is
--     a best-effort Expo push (sendCollaborationInvitePush ->
--     get_collaboration_invite_push_target in src/lib/notifications.ts).
--     That RPC returns zero rows -- and the client's own
--     `if (rows.length === 0) return` makes it a silent no-op -- for any
--     account with no push_tokens row yet (a brand-new signup, exactly what
--     a second real test account looks like), anyone who declined the iOS
--     notification prompt, or any push that simply didn't arrive.
--   * A pending invite is deliberately invisible until accepted:
--     has_aircraft_access() (sync/migrations_fix_has_aircraft_access_pending_
--     invite_leak.sql) requires accepted_at IS NOT NULL -- correct, and NOT
--     changed here -- so collaborators_view_shared_aircraft can't return the
--     aircraft row, and the invitee's My Aircraft list stayed empty even
--     though a real invite existed for them.
--   * Nothing else in the app ever listed pending invites at all -- the only
--     roster view is get_aircraft_collaborators(), which is owner-only (it
--     raises for anyone who isn't the aircraft's owner).
--
-- So a Callsign invite whose push didn't land was unrecoverable: correct in
-- the database (aircraft_collaborators already had a real row: real
-- owner_id, real user_id, real invite_token, accepted_at NULL), but
-- undiscoverable in the app. The client-side fix (My Aircraft now lists
-- pending invites with Accept/Decline, same place the roster shows them to
-- the owner) needs no migration to FUNCTION -- users_view_own_aircraft_
-- collaborations (auth.uid() = user_id) already lets an invitee read their
-- own row including invite_token, and join_shared_aircraft already accepts
-- it.
--
-- This migration only supplies the LABEL: the aircraft's make/model/
-- nickname and the inviter's callsign, which RLS correctly withholds until
-- acceptance. The client treats it as best-effort and falls back to "An
-- aircraft" / "You were invited to collaborate" if it isn't applied, so
-- applying this is a cosmetic upgrade, never a prerequisite for Accept/
-- Decline to work.
--
-- SECURITY
-- --------
-- SECURITY DEFINER, but strictly self-scoped: it can only ever return rows
-- where aircraft_collaborators.user_id = auth.uid(), so it discloses nothing
-- beyond "the aircraft you were personally invited to is a Cessna 172,
-- tail-nicknamed X, and Y invited you" -- both facts the push notification
-- would have stated anyway. It exposes no equipment, no reminders, no ADs,
-- no other collaborator, and no invite belonging to anyone else. Deliberately
-- does NOT return invite_token: the client reads that from its own
-- aircraft_collaborators row under existing RLS, so this function never
-- needs to hand out a credential.
-- ============================================================================

drop function if exists public.get_my_pending_aircraft_invites();

create function public.get_my_pending_aircraft_invites()
returns table(out_aircraft_id uuid, out_nickname text, out_make text, out_model text, out_inviter_label text, out_invited_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    ac.aircraft_id,
    ua.nickname,
    ua.make,
    ua.model,
    coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
    ac.joined_at
  from aircraft_collaborators ac
  join user_aircraft ua on ua.id = ac.aircraft_id
  join auth.users u on u.id = ac.owner_id
  left join callsign_registry cr on cr.user_id = ac.owner_id
  where ac.user_id = auth.uid()
    and ac.left_at is null
    and ac.accepted_at is null
    and ac.invite_token is not null;
$$;

revoke all on function public.get_my_pending_aircraft_invites() from public, anon;
grant execute on function public.get_my_pending_aircraft_invites() to authenticated;

-- Verification (run as the INVITEE's session, not service_role):
--   select * from get_my_pending_aircraft_invites();
-- Expect exactly that account's own unaccepted Callsign invites, and nothing
-- for an account with none. Run it as the OWNER of an aircraft they invited
-- someone to as well -- it must return zero rows there, since the owner is
-- not the invitee.
