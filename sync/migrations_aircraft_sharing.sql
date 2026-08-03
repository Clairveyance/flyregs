-- ============================================================================
-- Fleet aircraft sharing: viewer/editor collaborators                2026-08-04
-- ============================================================================
--
-- RC, after seeing the Fleet mockup: "anyone who is going to be receiving and
-- viewing Fleet data has to, themselves, have a Prem account... you'll need
-- to build in the 'editor' side of the perms. that part doesn't exist w/
-- shared folder." Checked folder_collaborators directly before building this
-- -- it's read-only by design (no role column at all, one collaborator
-- shape), confirming the gap is real, not just a naming thing.
--
-- Mirrors folder_collaborators' shape (owner_id/user_id/joined_at/left_at)
-- but adds the role split folders never needed, since folder sharing was
-- deliberately view-only from day one. Every collaborator still needs their
-- OWN Premium subscription (RC: "if you're at this level, you can pay for
-- Prem") -- this table only controls what a Premium account can see/do
-- with a shared aircraft, it never substitutes for the collaborator's own
-- subscription check, which stays enforced client-side exactly like
-- folder sharing already does for AC text.
--
-- Uses a short manually-entered CODE, not a flyregs.com/join/{token}
-- website landing page like folders -- that page is a separate deploy
-- surface (real FTP to production Bluehost) and RC's ask was to get
-- something real into the app to play with now, not stand up new website
-- infrastructure in the same pass. Same underlying redeem-a-token pattern
-- as folders either way; upgrading to a real universal link later is a
-- pure addition, not a rework, if RC wants that parity.
-- ============================================================================

alter table public.user_aircraft
  add column if not exists share_code text unique,
  add column if not exists share_code_role text check (share_code_role in ('viewer','editor'));

create table if not exists public.aircraft_collaborators (
  aircraft_id uuid not null references public.user_aircraft(id) on delete cascade,
  owner_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('viewer','editor')),
  joined_at timestamptz not null default now(),
  last_viewed_at timestamptz,
  left_at timestamptz,
  primary key (aircraft_id, user_id)
);

alter table public.aircraft_collaborators enable row level security;

-- Same 4-policy shape as folder_collaborators: owner manages the roster,
-- collaborator sees/updates only their own membership row.
create policy owners_view_aircraft_collaborators on public.aircraft_collaborators
  for select using (auth.uid() = owner_id);
create policy users_view_own_aircraft_collaborations on public.aircraft_collaborators
  for select using (auth.uid() = user_id);
create policy owners_remove_aircraft_collaborators on public.aircraft_collaborators
  for delete using (auth.uid() = owner_id);
create policy users_leave_shared_aircraft on public.aircraft_collaborators
  for delete using (auth.uid() = user_id);
create policy users_mark_own_aircraft_collaboration_viewed on public.aircraft_collaborators
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Helper, reused by every RLS policy below so the "can this user touch this
-- aircraft, and how" logic lives in exactly one place instead of being
-- copy-pasted (and potentially drifting) across 4 tables' policies.
create or replace function public.has_aircraft_access(p_aircraft_id uuid, p_require_editor boolean default false)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select exists (
    select 1 from aircraft_collaborators ac
    where ac.aircraft_id = p_aircraft_id
      and ac.user_id = auth.uid()
      and ac.left_at is null
      and (not p_require_editor or ac.role = 'editor')
  );
$function$;

-- ── user_aircraft: add collaborator access alongside the existing,
-- untouched owner-only ALL policy ─────────────────────────────────────────
create policy collaborators_view_shared_aircraft on public.user_aircraft
  for select using (has_aircraft_access(id));
create policy editors_update_shared_aircraft on public.user_aircraft
  for update using (has_aircraft_access(id, true)) with check (has_aircraft_access(id, true));

-- ── user_aircraft_equipment: same pattern, scoped via the parent aircraft ──
create policy collaborators_view_shared_equipment on public.user_aircraft_equipment
  for select using (has_aircraft_access(user_aircraft_id));
create policy editors_manage_shared_equipment on public.user_aircraft_equipment
  for all using (has_aircraft_access(user_aircraft_id, true)) with check (has_aircraft_access(user_aircraft_id, true));

-- ── user_aircraft_reminders: a reminder belongs to the AIRCRAFT, not just
-- to whoever happened to create it -- once sharing exists, "acknowledge
-- compliance" only means anything if every collaborator sees the same
-- reminders. Existing owner policy (user_id = auth.uid()) is untouched and
-- still covers the owner's own reminders; these two ADD real cross-
-- collaborator visibility/editing on top, they don't replace anything. ──
create policy collaborators_view_shared_reminders on public.user_aircraft_reminders
  for select using (has_aircraft_access(user_aircraft_id));
create policy editors_manage_shared_reminders on public.user_aircraft_reminders
  for all using (has_aircraft_access(user_aircraft_id, true)) with check (has_aircraft_access(user_aircraft_id, true));

-- ── user_ad_notifications: same reasoning as reminders -- whether AD
-- 2012-19-01 is dismissed is a fact about the airframe, not a personal
-- preference of whoever dismissed it, so every collaborator needs to see
-- the same state. Existing owner policies untouched. ─────────────────────
create policy collaborators_view_shared_ad_notifications on public.user_ad_notifications
  for select using (has_aircraft_access(user_aircraft_id));
create policy editors_manage_shared_ad_notifications on public.user_ad_notifications
  for update using (has_aircraft_access(user_aircraft_id, true)) with check (has_aircraft_access(user_aircraft_id, true));

-- ── Bug found by real end-to-end testing, not caught by reading the SQL:
-- the ORIGINAL user_aircraft_reminders_own_rows policy (from before sharing
-- existed) only checked `auth.uid() = user_id` -- it never verified the
-- referenced aircraft was actually theirs, because before sharing, nobody
-- could reference an aircraft_id they didn't own in the first place. Once a
-- viewer legitimately learns a real aircraft_id (via their new, correct
-- SELECT access), that old policy let them INSERT a reminder against an
-- aircraft they only have VIEW rights to, just by setting user_id to
-- themselves -- confirmed live with 4 real disposable test accounts
-- (owner/editor/viewer/stranger) before this was caught; a viewer insert
-- succeeded when it should have been rejected. Postgres RLS policies
-- combine with OR, so the new editors_manage_shared_reminders policy being
-- correct didn't matter -- the old permissive policy still let it through
-- on its own. Fixed by replacing the original policy so its own USING/WITH
-- CHECK also verifies aircraft ownership, not just self-authorship. Full
-- 11-check test suite (join both roles, editor read/write, viewer read-
-- only, stranger sees nothing, owner's own solo flow unaffected) passes
-- clean after this fix. ─────────────────────────────────────────────────
drop policy if exists user_aircraft_reminders_own_rows on public.user_aircraft_reminders;
create policy user_aircraft_reminders_own_rows on public.user_aircraft_reminders
  for all
  using (
    auth.uid() = user_id
    and exists (select 1 from user_aircraft ua where ua.id = user_aircraft_id and ua.user_id = auth.uid())
  )
  with check (
    auth.uid() = user_id
    and exists (select 1 from user_aircraft ua where ua.id = user_aircraft_id and ua.user_id = auth.uid())
  );

-- ── Join RPC: mirrors join_shared_folder's shape (SECURITY DEFINER so a
-- non-owner can look up an aircraft by code without a standing SELECT
-- policy that would leak every aircraft's existence) ─────────────────────
create or replace function public.join_shared_aircraft(p_code text)
returns table(out_aircraft_id uuid, out_nickname text, out_make text, out_model text, out_role text)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_aircraft record;
begin
  select id, user_id, nickname, make, model, share_code_role
  into v_aircraft
  from user_aircraft
  where share_code = p_code;

  if not found then
    raise exception 'Invalid or expired invite code';
  end if;

  if v_aircraft.user_id = auth.uid() then
    raise exception 'This is your own aircraft';
  end if;

  insert into aircraft_collaborators (aircraft_id, owner_id, user_id, role)
  values (v_aircraft.id, v_aircraft.user_id, auth.uid(), v_aircraft.share_code_role)
  on conflict (aircraft_id, user_id) do update
    set role = excluded.role, left_at = null, joined_at = now();

  return query select v_aircraft.id, v_aircraft.nickname, v_aircraft.make, v_aircraft.model, v_aircraft.share_code_role;
end;
$function$;
