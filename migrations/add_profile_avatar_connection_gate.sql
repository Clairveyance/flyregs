-- RC, 2026-08-08: "images or other personal content will be anonymized to
-- people you don't collab with, until you invite/accept a connection." A
-- real, server-side "are these two users connected" check, checked once
-- here rather than trusting the client -- avatar_url lives in
-- auth.users.raw_user_meta_data, which the client SDK can't read for any
-- account but its own, so this RPC is the ONLY way another user's real
-- photo can reach a viewer at all: no connection, no avatar_url in the
-- response, ever (not "hidden client-side" -- never transmitted).
--
-- "Connected" = an active (not left_at, and for aircraft also accepted_at)
-- folder_collaborators or aircraft_collaborators row between the two users,
-- in either direction (owner viewing collaborator, or collaborator viewing
-- owner). Scoped to collaboration only, matching RC's own word "collab" --
-- Duels/challenges opponents are a different relationship and explicitly
-- left out of this pass; RC: "that's easier for now, and we can look into
-- expanding that later."
create or replace function public.get_profile_avatar(p_user_id uuid)
returns table(out_avatar_url text, out_avatar_preset text, out_connected boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_connected boolean;
  v_avatar_url text;
  v_avatar_preset text;
begin
  if p_user_id = auth.uid() then
    v_connected := true;
  else
    select
      exists (
        select 1 from folder_collaborators fc
        where fc.left_at is null and (
          (fc.owner_id = auth.uid() and fc.user_id = p_user_id) or
          (fc.user_id = auth.uid() and fc.owner_id = p_user_id)
        )
      )
      or exists (
        select 1 from aircraft_collaborators ac
        where ac.left_at is null and ac.accepted_at is not null and (
          (ac.owner_id = auth.uid() and ac.user_id = p_user_id) or
          (ac.user_id = auth.uid() and ac.owner_id = p_user_id)
        )
      )
    into v_connected;
  end if;

  if v_connected then
    select (u.raw_user_meta_data->>'avatar_url'), (u.raw_user_meta_data->>'avatar_preset')
      into v_avatar_url, v_avatar_preset
      from auth.users u where u.id = p_user_id;
  end if;

  return query select v_avatar_url, v_avatar_preset, coalesce(v_connected, false);
end;
$function$;

grant execute on function public.get_profile_avatar(uuid) to authenticated;
