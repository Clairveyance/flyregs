-- Re-inviting someone to a folder or aircraft sent no notification at all.
--
-- Found 2026-09-12 during a full walkthrough, from a stray 400 in the console.
--
-- `invite_folder_collaborator` (and its aircraft twin) does:
--     insert into folder_collaborators (...) values (...)
--     on conflict (folder_id, user_id) do update
--       set joined_at = now(), accepted_at = null,
--           invite_token = excluded.invite_token, left_at = null;
--
-- but the push trigger was AFTER **INSERT** only. So:
--   1st invite  -> INSERT   -> trigger fires -> push sent, invite_pushed_at = T1
--   they leave / decline / it is re-sent
--   2nd invite  -> UPDATE   -> trigger does NOT fire -> no push
--
-- and the client-side backstop could not cover it either, because
-- get_collaboration_invite_push_target suppresses itself when
-- invite_pushed_at is already set -- which it still was, from T1. The invite
-- landed silently in Saved > Shared > With Me and nothing told the recipient.
--
-- That is exactly the CFI case: a folder shared with students, someone leaves
-- or is re-invited, and the re-invite is the one that goes quiet. It is also
-- the shape of RC's older report, "There is zero notification happening when
-- somebody invites you to a folder" -- fixed once for the first invite, never
-- for the second.
--
-- FIX: fire on the re-invite too. `update of invite_token` means an ordinary
-- UPDATE (accepting, changing collab_mode, marking invite_pushed_at) does not
-- re-notify -- only a genuinely new invite token does, which is exactly what
-- invite_folder_collaborator writes when it re-invites. The function's own
-- closing `update ... set invite_pushed_at = now()` touches a different column,
-- so it cannot retrigger itself.
--
-- The function also gains an explicit same-token guard, so that even if a
-- future caller lists invite_token in a SET without changing it, this cannot
-- turn into a duplicate notification.

begin;

create or replace function public.notify_collab_invite()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor text; v_label text; v_title text; v_body text; v_tok text;
  v_kind text := case when TG_TABLE_NAME = 'aircraft_collaborators' then 'aircraft' else 'folder' end;
begin
  if new.user_id is null or new.accepted_at is not null or new.left_at is not null then return new; end if;
  if new.owner_id is null or new.owner_id = new.user_id then return new; end if;
  -- Only a genuinely NEW invite token is a new invite worth notifying about.
  if TG_OP = 'UPDATE' and new.invite_token is not distinct from old.invite_token then
    return new;
  end if;
  v_actor := display_label_for(new.owner_id);
  if v_actor is null then return new; end if;

  if v_kind = 'aircraft' then
    select coalesce(
             nullif(trim(coalesce(ua.nickname, '')), ''),
             nullif(trim(coalesce(ua.make, '') || ' ' || coalesce(ua.model, '')), ''),
             'an aircraft') into v_label
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
    perform push_expo_message(v_tok, v_title, v_body,
      jsonb_build_object('type', 'collab-invite', 'token', new.invite_token));
  end loop;

  if TG_TABLE_NAME = 'aircraft_collaborators' then
    update aircraft_collaborators set invite_pushed_at = now()
    where aircraft_id = new.aircraft_id and user_id = new.user_id;
  else
    update folder_collaborators set invite_pushed_at = now()
    where folder_id = new.folder_id and user_id = new.user_id;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_notify_folder_invite on public.folder_collaborators;
create trigger trg_notify_folder_invite
  after insert or update of invite_token on public.folder_collaborators
  for each row execute function public.notify_collab_invite();

drop trigger if exists trg_notify_aircraft_invite on public.aircraft_collaborators;
create trigger trg_notify_aircraft_invite
  after insert or update of invite_token on public.aircraft_collaborators
  for each row execute function public.notify_collab_invite();

commit;
