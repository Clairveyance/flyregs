-- ============================================================================
-- Aircraft sharing: owner can change an EXISTING collaborator's role       2026-08-19
-- ============================================================================
--
-- RC: "yes, build the a/c sharing change role capability" -- confirmed via a
-- clarifying question to mean letting an owner change a collaborator's role
-- (viewer<->editor) AFTER they've already joined, not just at invite time.
--
-- Until now the ONLY way a role was ever set was getOrCreateShareLink minting
-- a share_code/share_code_role pair -- per that function's own comment in
-- aircraftSharing.ts, "Regenerating changes the role for FUTURE joiners only
-- -- it never touches collaborators who already joined under the previous
-- link." There was genuinely no path anywhere (RLS, RPC, or otherwise) that
-- could touch an existing collaborator's role column after they joined --
-- confirmed live: aircraft_collaborators has SELECT (owner/self), DELETE
-- (owner remove / self leave), and exactly one UPDATE policy
-- (users_mark_own_aircraft_collaboration_viewed, self-only, last_viewed_at in
-- intent) -- no owner-side UPDATE policy at all.
--
-- SECURITY DEFINER RPC, not a raw owner UPDATE RLS policy -- matches this
-- codebase's established pattern for sensitive collaborator mutations
-- (get_aircraft_collaborators is already an RPC; invite_aircraft_collaborator
-- likewise) and keeps the authorization check narrow/auditable in one place
-- rather than a general table-level grant. Deliberately does NOT add any new
-- RLS policy to aircraft_collaborators -- the guard trigger from
-- migrations_fix_collaborator_self_escalation.sql
-- (guard_aircraft_collaborator_self_update) already anticipated this exact
-- feature ("owner acting directly, e.g. a future owner-side role editor" /
-- "current_user not in ('authenticated','anon')" for a SECURITY DEFINER RPC
-- context) -- both of its escape hatches already let this RPC's internal
-- UPDATE through untouched, with zero trigger changes needed.
--
-- Self-escalation is guarded THREE independent ways, not just one:
--   1. Authorization here only ever checks "does auth.uid() own the
--      aircraft" (the same check get_aircraft_collaborators/invite_aircraft_
--      collaborator already use) -- a collaborator calling this against
--      their own aircraft_id fails that check outright, since only the
--      owner's user_id on user_aircraft satisfies it.
--   2. Defense in depth even though currently unreachable: explicitly
--      rejects p_user_id = auth.uid(). An owner is never their own
--      collaborator row per this schema (join_shared_aircraft already
--      refuses "this is your own aircraft" self-joins) -- verified live,
--      0 of the current aircraft_collaborators rows have owner_id = user_id
--      -- but this makes that assumption load-bearing code, not just a
--      comment that could silently go stale.
--   3. The guard trigger's OWN self-update path
--      (users_mark_own_aircraft_collaboration_viewed, `auth.uid() =
--      user_id`) is completely untouched by this migration and stays
--      restricted to last_viewed_at / one-way left_at only -- a
--      collaborator still cannot ride that policy to change their own role,
--      before or after this change ships.
-- ============================================================================

create or replace function public.update_aircraft_collaborator_role(p_aircraft_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from user_aircraft where id = p_aircraft_id and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  if p_role not in ('viewer', 'editor') then
    raise exception 'Invalid role';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'Cannot change your own role';
  end if;

  if not exists (
    select 1 from aircraft_collaborators
    where aircraft_id = p_aircraft_id and user_id = p_user_id and left_at is null
  ) then
    raise exception 'Collaborator not found';
  end if;

  update aircraft_collaborators
    set role = p_role
    where aircraft_id = p_aircraft_id and user_id = p_user_id and left_at is null;
end;
$$;
grant execute on function update_aircraft_collaborator_role(uuid, uuid, text) to authenticated;
