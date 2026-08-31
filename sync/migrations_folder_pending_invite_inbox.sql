-- ============================================================================
-- Folder sharing: let an invitee SEE a pending Callsign invite in the app
--                                                              2026-08-30
-- ============================================================================
--
-- NOT YET APPLIED. Written by an investigation pass under this project's
-- standing "sweep agents are never destructive" rule -- review and apply
-- from the calling session.
--
-- WHY
-- ---
-- Four separate real-device reports across three joint testing sessions all
-- said the same thing about invite-by-Callsign (2026-08-17; 2026-08-22
-- feedback ea844156; 2026-08-29 feedback e94a988c and 0d73eb1f). The most
-- diagnostic one, e94a988c:
--
--   "it allows me to type the call sign, it says it actually found the Call
--    sign which is good, and then I send the invite and it gives me a
--    notification that the invite was sent ... BUT it doesn't seem like it
--    actually sends anything. The other person never gets any kind of
--    notification."
--
-- Confirmed against the live database, not inferred: the invite itself was
-- never what failed. folder_collaborators still carries RC's 2026-08-29
-- 04:12:07Z invite to Adriana on folder mtduuv1moovst -- real owner_id, real
-- user_id, real invite_token, accepted_at NULL -- days later. What was
-- missing is any way for the RECIPIENT to discover it:
--
--   * The only delivery channel was an Expo push
--     (sendCollaborationInvitePush -> get_collaboration_invite_push_target).
--     Adriana's account was ~13 minutes old at that moment with no
--     push_tokens row at all, so that RPC returned zero rows and the client's
--     own `if (rows.length === 0) return` made it a silent no-op. Same
--     outcome for anyone who declined the iOS notification prompt, or whose
--     push simply didn't arrive.
--   * A pending invite is deliberately invisible until accepted:
--     collaborators_view_shared_folders (migrations_fix_folder_pending_
--     invite_leak.sql) requires accepted_at IS NOT NULL -- correct, and NOT
--     changed here -- so the folder row itself is unreadable, and Shared >
--     With Me stayed empty.
--   * Nothing else in the app listed pending invites at all.
--
-- So a Callsign invite whose push didn't land was unrecoverable: correct in
-- the database, undiscoverable in the app. The client-side fix (Saved >
-- Shared > With Me now lists pending invites with Accept/Decline) needs no
-- migration to FUNCTION -- users_view_own_collaborations (auth.uid() =
-- user_id) already lets an invitee read their own row including
-- invite_token, and join_shared_folder already accepts it.
--
-- This migration only supplies the LABEL: the folder's name and the
-- inviter's callsign, which RLS correctly withholds until acceptance. The
-- client treats it as best-effort and falls back to "A shared folder" /
-- "You were invited to collaborate" if it isn't applied, so applying this is
-- a cosmetic upgrade, never a prerequisite.
--
-- SECURITY
-- --------
-- SECURITY DEFINER, but strictly self-scoped: it can only ever return rows
-- where folder_collaborators.user_id = auth.uid(), so it discloses nothing
-- beyond "the folder you were personally invited to is called X, and Y
-- invited you" -- both facts the invite notification would have stated
-- anyway. It exposes no folder CONTENTS, no other collaborator, and no
-- invite belonging to anyone else. Deliberately does NOT return
-- invite_token: the client reads that from its own folder_collaborators row
-- under existing RLS, so this function never needs to hand out a credential.
-- ============================================================================

drop function if exists public.get_my_pending_folder_invites();

create function public.get_my_pending_folder_invites()
returns table(out_folder_id text, out_folder_name text, out_inviter_label text, out_invited_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    fc.folder_id,
    sf.name::text,
    coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
    fc.joined_at
  from folder_collaborators fc
  join synced_folders sf on sf.id = fc.folder_id and sf.deleted = false
  join auth.users u on u.id = fc.owner_id
  left join callsign_registry cr on cr.user_id = fc.owner_id
  where fc.user_id = auth.uid()
    and fc.left_at is null
    and fc.accepted_at is null
    and fc.invite_token is not null;
$$;

revoke all on function public.get_my_pending_folder_invites() from public, anon;
grant execute on function public.get_my_pending_folder_invites() to authenticated;

-- Verification (run as the INVITEE's session, not service_role):
--   select * from get_my_pending_folder_invites();
-- Expect exactly that account's own unaccepted Callsign invites, and nothing
-- for an account with none. Run it as the OWNER of a folder they invited
-- someone to as well -- it must return zero rows there, since the owner is
-- not the invitee.
