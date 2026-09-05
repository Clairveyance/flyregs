-- One display-label helper, and the reason get_shared_highlights needed it.
--
-- BUG SHIPPED AND CAUGHT THE SAME DAY (2026-09-05, whole-app sweep).
-- get_shared_highlights is SECURITY INVOKER on purpose -- the RLS on
-- synced_bookmarks is the gate, and restating it in a definer function is how
-- user_duel_stats leaked. But an invoker function also cannot read anything
-- the CALLER cannot read, and callsign_registry has RLS enabled with ZERO
-- policies: no client can select from it at all. Every callsign in this app
-- is served through a SECURITY DEFINER RPC.
--
-- So the LEFT JOIN on callsign_registry always produced NULL and
-- `coalesce(cr.callsign, 'A collaborator')` always fell through. The long-press
-- menu would have read "Remove A collaborator's Highlight" for every
-- highlight, for everyone -- plausible enough to ship and wrong for everybody.
-- Proven by the check now in scripts/shared_folder_highlights_e2e_test.py,
-- which asserts the real callsign and failed before this migration.
--
-- duel_actor_label (added earlier the same day for the push triggers) already
-- solved exactly this, as SECURITY DEFINER. It is renamed here rather than
-- copied: a second function doing the same job is how two labels drift into
-- disagreeing about what to call the same person.

begin;

create or replace function public.display_label_for(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Pilot')
  from auth.users u
  left join callsign_registry cr on cr.user_id = u.id
  where u.id = p_user_id;
$$;

revoke all on function public.display_label_for(uuid) from public, anon;
-- get_shared_highlights runs as the CALLER, so the caller must be able to
-- execute this. It returns one label for one user id and nothing else --
-- the same information a shared folder already shows.
grant execute on function public.display_label_for(uuid) to authenticated;

-- Repoint the three push triggers, then drop the old name so there is only
-- ever one definition.
create or replace function public.notify_duel_invite()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_actor text; v_tok text;
begin
  if new.status is distinct from 'pending' then return new; end if;
  select display_label_for(c.challenger_id) into v_actor from challenges c where c.id = new.challenge_id;
  if v_actor is null then return new; end if;
  for v_tok in
    select pt.expo_push_token from push_tokens pt
    where pt.user_id = new.user_id and pt.expo_push_token is not null
      and pt.duel_notifications_enabled = true
  loop
    perform push_expo_message(v_tok, 'Duel Invite',
      v_actor || ' is challenging you to a duel. Accept or decline?',
      jsonb_build_object('type', 'duel', 'challengeId', new.challenge_id));
  end loop;
  return new;
end;
$$;

create or replace function public.notify_duel_accepted()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_actor text; v_creator_id uuid; v_tok text;
begin
  if old.status is not distinct from new.status then return new; end if;
  if new.status is distinct from 'active' then return new; end if;
  if old.status is distinct from 'pending' then return new; end if;
  if new.is_creator then return new; end if;
  select cp.user_id into v_creator_id from challenge_participants cp
   where cp.challenge_id = new.challenge_id and cp.is_creator = true limit 1;
  if v_creator_id is null or v_creator_id = new.user_id then return new; end if;
  v_actor := display_label_for(new.user_id);
  if v_actor is null then return new; end if;
  for v_tok in
    select pt.expo_push_token from push_tokens pt
    where pt.user_id = v_creator_id and pt.expo_push_token is not null
      and pt.duel_notifications_enabled = true
  loop
    perform push_expo_message(v_tok, 'Duel Accepted',
      v_actor || ' accepted your duel — your move',
      jsonb_build_object('type', 'duel', 'challengeId', new.challenge_id));
  end loop;
  return new;
end;
$$;

create or replace function public.notify_collab_invite()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor text; v_label text; v_title text; v_body text; v_tok text;
  v_kind text := case when TG_TABLE_NAME = 'aircraft_collaborators' then 'aircraft' else 'folder' end;
begin
  if new.user_id is null or new.accepted_at is not null or new.left_at is not null then return new; end if;
  if new.owner_id is null or new.owner_id = new.user_id then return new; end if;
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
$$;

-- get_shared_highlights: label through the definer helper instead of a
-- LEFT JOIN the caller can never satisfy.
create or replace function public.get_shared_highlights(
  p_item_type text,
  p_ac_id     text
) returns table(
  id text, owner_id uuid, owner_label text, block_kind text,
  block_label text, block_snippet text, block_text text, can_edit boolean
)
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $$
  select distinct on (sb.id)
    sb.id,
    sb.user_id as owner_id,
    -- display_label_for is SECURITY DEFINER: callsign_registry has RLS on
    -- with no policies, so an invoker query against it returns NULL for
    -- everyone and the coalesce fallback silently wins. See this file's header.
    coalesce(display_label_for(sb.user_id), 'A collaborator') as owner_label,
    sb.block_kind, sb.block_label, sb.block_snippet, sb.block_text,
    bool_or(folder_owner_id(sfi.folder_id) = auth.uid() or has_folder_access(sfi.folder_id, true))
      over (partition by sb.id) as can_edit
  from synced_bookmarks sb
  join synced_folder_items sfi
    on sfi.item_id = sb.id and sfi.item_type <> 'note' and sfi.deleted = false
  where sb.deleted = false
    and sb.block_text is not null
    and sb.ac_id = p_ac_id
    and sb.item_type = p_item_type
    and sb.user_id <> auth.uid()
  order by sb.id, can_edit desc;
$$;

grant execute on function public.get_shared_highlights(text, text) to authenticated;
revoke execute on function public.get_shared_highlights(text, text) from anon, public;

drop function if exists public.duel_actor_label(uuid);

commit;
