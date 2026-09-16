-- "Who collaborates here?" must answer "nobody you can see", not fail.
--
-- RC, 2026-09-16: "figure out that 400 error and fix it."
--
-- Captured live with a temporary diagnostic fetch on the Supabase client
-- (window.fetch patching never caught it -- supabase-js bundles its own fetch
-- ponyfill, so a runtime monkey-patch of the global is invisible to it):
--
--   [SB-DIAG] 400 POST /rest/v1/rpc/get_folder_collaborators
--             {"code":"P0001","message":"Not authorized"}   x4
--
-- WHY IT FIRES CONSTANTLY, AND ON REAL DEVICES
-- get_folder_collaborators gated on `synced_folders where id = p_folder_id and
-- user_id = auth.uid()` -- i.e. the caller must OWN the folder row. Verified
-- against live data: **no collaborator has their own synced_folders row**
-- (`collab_has_own_row` is false for every row in folder_collaborators). And
-- folder/[id].tsx calls this on every load, ungated, on the belief -- stated in
-- its own comment -- that the RPC "just returns an empty list" for a folder with
-- no sharing. It does not; it raises.
--
-- So this 400s:
--   * every time a COLLABORATOR opens a folder shared with them (the common
--     case -- RC's own account is a collaborator on one),
--   * every time anyone opens a folder whose server row is gone (exactly what
--     Adriana's device hit during the 2026-08-29 WatchdogTermination
--     investigation, where it was recorded as "correctly 400'd"),
--   * and on a newly created folder opened before its local-first sync push
--     has landed.
--
-- None of it is visible to the user: both call sites are
-- `.catch(() => setCollaborators([]))`, and the "Folder no longer available"
-- screen is driven by the LOCAL folder lookup, not by this error.
--
-- CHECKED, not assumed: these do NOT currently reach Sentry. `sentry.ts` sets
-- `enableCaptureFailedRequests: true` but does not set
-- `failedRequestStatusCodes`, and the SDK default is `[[500, 599]]` -- 4xx is
-- excluded. (An earlier draft of this comment claimed each 400 became a Sentry
-- event with a screenshot; that was wrong, and the Sentry issue list confirms
-- no such issue exists.) What it actually costs: a wasted round trip and a real
-- server error on a completely ordinary action, on every folder open by a
-- collaborator, plus a red console error for anyone debugging. It is still
-- wrong -- and it is a landmine, because the moment anyone widens
-- failedRequestStatusCodes to cover 4xx (which `sentry.ts`'s own comment argues
-- for, since supabase-js failures are overwhelmingly 4xx), this becomes exactly
-- the flood described above.
--
-- THE FIX, AND WHY EMPTY RATHER THAN A RAISE
-- A read-only "list what I can see" query should answer with what you can see.
-- Returning zero rows:
--   * discloses nothing new -- an unauthorized caller received zero rows before
--     and receives zero rows now; the only thing lost is the ability to tell
--     "no collaborators" from "not your folder", and no caller uses it,
--   * stops manufacturing a failed HTTP request for an ordinary, expected state.
-- A raise is right for a WRITE that must be refused. It is wrong for a read
-- whose honest answer is "nothing".
--
-- Deliberately NOT widening who can see the roster: a collaborator still gets an
-- empty list, exactly as today. That is a product decision (should students see
-- each other?) and this change must not smuggle it in.

begin;

create or replace function public.get_folder_collaborators(p_folder_id text)
returns table(
  out_user_id uuid, out_display_label text, out_joined_at timestamp with time zone,
  out_left_at timestamp with time zone, out_last_viewed_at timestamp with time zone,
  out_collab_mode text, out_accepted boolean
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Not the owner (or the folder is gone, or has not synced yet): nothing to
  -- show. Returning rather than raising -- see this migration's header.
  if not exists (select 1 from synced_folders where id = p_folder_id and user_id = auth.uid()) then
    return;
  end if;

  return query
    select
      fc.user_id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
      fc.joined_at,
      fc.left_at,
      fc.last_viewed_at,
      fc.collab_mode,
      (fc.accepted_at is not null)
    from folder_collaborators fc
    join auth.users u on u.id = fc.user_id
    left join callsign_registry cr on cr.user_id = fc.user_id
    where fc.folder_id = p_folder_id;
end;
$function$;

-- Same shape, same reasoning. my-aircraft/[id].tsx already gates this call on
-- `resolvedRole === 'owner'`, so it fires less often -- but an owner opening an
-- aircraft whose server row is gone still takes the same pointless 400, and the
-- two functions should not disagree about what "no access" means.
create or replace function public.get_aircraft_collaborators(p_aircraft_id uuid)
returns table(
  out_user_id uuid, out_display_label text, out_role text,
  out_joined_at timestamp with time zone, out_last_viewed_at timestamp with time zone,
  out_accepted boolean
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (select 1 from user_aircraft where id = p_aircraft_id and user_id = auth.uid()) then
    return;
  end if;

  return query
    select ac.user_id, coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')::text,
      ac.role, ac.joined_at, ac.last_viewed_at, (ac.accepted_at is not null)
    from aircraft_collaborators ac
    join auth.users u on u.id = ac.user_id
    left join callsign_registry cr on cr.user_id = ac.user_id
    where ac.aircraft_id = p_aircraft_id and ac.left_at is null;
end;
$function$;

commit;
