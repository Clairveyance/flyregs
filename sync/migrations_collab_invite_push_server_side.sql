-- Folder / aircraft invite pushes move OFF the client, same as the duel ones.
--
-- RC, 2026-09-05: "There is zero notification happening when somebody invites
-- you to a folder. Those notifications should be happening on a person's phone
-- lock screen just like any other notification."
--
-- Identical root cause to the duel invite (see
-- migrations_duel_push_server_side.sql): sendCollaborationInvitePush() ran in
-- the INVITER's app, after the invite row was already written and the confirm
-- dialog was already on screen -- an RPC round-trip plus an exp.host POST that
-- only completed if that phone stayed awake and online long enough. It also
-- swallowed every failure at three separate points, so nobody could tell
-- "never sent" from "sent and lost".
--
-- Verified live before writing this, so the cause is not guesswork: all three
-- real accounts have a push_tokens row, and get_collaboration_invite_push_target
-- has no preference gate at all -- targeting was never the problem.
--
-- Fires on the INSERT of a named invite (user_id present, not yet accepted).
-- An anonymous share LINK inserts no collaborator row until the recipient
-- opens it, so link invites are untouched -- there is nobody to notify yet,
-- which is correct.
--
-- The client call is left in place deliberately and is NOT a duplicate: see
-- the guard below. It now only ever runs for a row this trigger has already
-- marked as pushed, and returns without sending.

begin;

-- Records that a server-side push already went out for this invite, so the
-- client's own best-effort call can tell and stand down. A column rather than
-- a separate table: it is one boolean per invite row, and it dies with the row.
alter table public.folder_collaborators   add column if not exists invite_pushed_at timestamptz;
alter table public.aircraft_collaborators add column if not exists invite_pushed_at timestamptz;

create or replace function public.notify_collab_invite()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor  text;
  v_label  text;
  v_title  text;
  v_body   text;
  v_tok    text;
  v_kind   text := case when TG_TABLE_NAME = 'aircraft_collaborators' then 'aircraft' else 'folder' end;
  v_sent   boolean := false;
begin
  -- A named, not-yet-accepted invite is the only thing worth notifying about.
  if new.user_id is null or new.accepted_at is not null or new.left_at is not null then return new; end if;
  if new.owner_id is null or new.owner_id = new.user_id then return new; end if;

  v_actor := duel_actor_label(new.owner_id);
  if v_actor is null then return new; end if;

  if v_kind = 'aircraft' then
    -- nickname, else "make model" -- the SAME label my-aircraft/[id].tsx
    -- builds for its own client-side push, so the two paths can never word
    -- the notification differently. user_aircraft has no tail_number column;
    -- referencing one here would have thrown on the first real aircraft
    -- invite and taken the whole INSERT down with it.
    select coalesce(
             nullif(trim(coalesce(ua.nickname, '')), ''),
             nullif(trim(coalesce(ua.make, '') || ' ' || coalesce(ua.model, '')), ''),
             'an aircraft'
           ) into v_label
    from user_aircraft ua where ua.id = new.aircraft_id;
    v_title := 'Aircraft invite';
    v_body  := v_actor || ' invited you to ' || coalesce(v_label, 'an aircraft');
  else
    select coalesce(nullif(trim(coalesce(sf.name, '')), ''), 'a folder') into v_label
    from synced_folders sf where sf.id = new.folder_id;
    v_title := 'Folder invite';
    v_body  := v_actor || ' invited you to the folder "' || coalesce(v_label, 'a folder') || '"';
  end if;

  for v_tok in
    select pt.expo_push_token from push_tokens pt
    where pt.user_id = new.user_id and pt.expo_push_token is not null
  loop
    perform push_expo_message(
      v_tok, v_title, v_body,
      jsonb_build_object('type', 'collab-invite', 'token', new.invite_token)
    );
    v_sent := true;
  end loop;

  -- Stamped even when the recipient had no token: the point of the flag is
  -- "the server has handled the notification for this invite", and a client
  -- retry would find no token either.
  if TG_TABLE_NAME = 'aircraft_collaborators' then
    update aircraft_collaborators set invite_pushed_at = now()
    where aircraft_id = new.aircraft_id and user_id = new.user_id;
  else
    update folder_collaborators set invite_pushed_at = now()
    where folder_id = new.folder_id and user_id = new.user_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_notify_folder_invite on public.folder_collaborators;
create trigger trg_notify_folder_invite
  after insert on public.folder_collaborators
  for each row execute function public.notify_collab_invite();

drop trigger if exists trg_notify_aircraft_invite on public.aircraft_collaborators;
create trigger trg_notify_aircraft_invite
  after insert on public.aircraft_collaborators
  for each row execute function public.notify_collab_invite();

-- The client's sendCollaborationInvitePush() calls this same RPC. Teach it to
-- return NOTHING once the trigger has already sent, so the two paths can never
-- double-notify while the older builds still in the field keep working.
create or replace function public.get_collaboration_invite_push_target(
  p_target_user_id uuid, p_resource_type text, p_resource_label text, p_token text
) returns table(expo_push_token text, title text, body text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_label text;
  v_verified boolean := false;
  v_already boolean := false;
begin
  if p_resource_type = 'aircraft' then
    select exists(
      select 1 from aircraft_collaborators ac
      where ac.owner_id = v_actor_id and ac.user_id = p_target_user_id
        and ac.invite_token = p_token and ac.accepted_at is null
    ) into v_verified;
    select exists(
      select 1 from aircraft_collaborators ac
      where ac.owner_id = v_actor_id and ac.user_id = p_target_user_id
        and ac.invite_token = p_token and ac.invite_pushed_at is not null
    ) into v_already;
  else
    select exists(
      select 1 from folder_collaborators fc
      where fc.owner_id = v_actor_id and fc.user_id = p_target_user_id
        and fc.invite_token = p_token and fc.accepted_at is null
    ) into v_verified;
    select exists(
      select 1 from folder_collaborators fc
      where fc.owner_id = v_actor_id and fc.user_id = p_target_user_id
        and fc.invite_token = p_token and fc.invite_pushed_at is not null
    ) into v_already;
  end if;

  if not v_verified then
    raise exception 'No matching pending invite found';
  end if;

  -- The database already pushed this invite. Returning rows here would send a
  -- second, identical notification from whichever build the inviter is on.
  if v_already then
    return;
  end if;

  select coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')
  into v_actor_label
  from auth.users u
  left join callsign_registry cr on cr.user_id = u.id
  where u.id = v_actor_id;

  return query
  select pt.expo_push_token,
    case p_resource_type when 'aircraft' then 'Aircraft invite' else 'Folder invite' end,
    case p_resource_type
      when 'aircraft' then v_actor_label || ' invited you to ' || p_resource_label
      else v_actor_label || ' invited you to the folder "' || p_resource_label || '"'
    end
  from push_tokens pt
  where pt.user_id = p_target_user_id
    and pt.user_id != v_actor_id
    and pt.expo_push_token is not null;
end;
$function$;

commit;
