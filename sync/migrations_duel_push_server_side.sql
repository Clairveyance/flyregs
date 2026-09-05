-- Duel invite/accept pushes move OFF the client and into the database.
--
-- RC, 2026-09-05: "The notifications for a duel challenge on the recipient
-- phone are still not working. Every other notification pops up... We need to
-- clarify the notification path for dual challenges." And: "you clearly see
-- the issue with the Duel invite pushes - so fix it."
--
-- THE ISSUE
-- sendDuelPush() ran in the SENDER's app: an RPC round-trip to
-- get_duel_push_target, then a second round-trip POSTing to exp.host -- both
-- fire-and-forget, both after the screen had already navigated away. Nothing
-- about that survives the sender locking their phone, switching apps, losing
-- signal, or the OS suspending the JS runtime, which on iOS happens within
-- seconds of backgrounding. Create a duel and put the phone in your pocket and
-- the invite is simply never sent -- with no error, no retry and no record,
-- because the code that would have reported it was suspended too.
--
-- Every one of the gates was verified live before writing this and none of
-- them was the cause: all three real accounts have a push_tokens row,
-- duel_notifications_enabled = true on all three, and
-- get_collaboration_invite_push_target/get_duel_push_target both resolve.
-- The delivery mechanism was the weak link, not the targeting.
--
-- THE FIX
-- The push is now sent by the database, inside the same transaction that
-- creates or accepts the participation, via pg_net (installed, v0.20.3).
-- pg_net queues the request and returns immediately, so it does not slow the
-- RPC down; a rolled-back transaction takes its queued request with it, so a
-- failed create_challenge can no longer notify anybody about a duel that does
-- not exist. Once the row is committed the send no longer depends on the
-- sender's device being awake at all.
--
-- The client's own sendDuelPush(_, 'invited') and (_, 'accepted') calls are
-- removed in the same change. Leaving them would double-notify.
--
-- 'answered' and 'completed' deliberately stay client-side for now: both fire
-- while the sender is demonstrably in the app and on that screen (they just
-- submitted an answer), which is the one situation the client path handles
-- reliably.

begin;

-- One place that actually posts to Expo, so the payload can't drift between
-- the two triggers below.
create or replace function public.push_expo_message(
  p_token text,
  p_title text,
  p_body  text,
  p_data  jsonb
) returns bigint
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  select net.http_post(
    url     := 'https://exp.host/--/api/v2/push/send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Accept', 'application/json'),
    body    := jsonb_build_object(
      'to',    p_token,
      'sound', 'default',
      'title', p_title,
      'body',  p_body,
      'data',  p_data,
      -- Matches the client sender. A duel is worthless half an hour late, and
      -- this is the one flag that gets a notification out of iOS's Scheduled
      -- Summary. Requires the time-sensitive entitlement in the BUILD
      -- (app.json ios.entitlements) -- without it iOS silently downgrades it.
      'interruptionLevel', 'time-sensitive'
    )
  );
$$;

revoke all on function public.push_expo_message(text, text, text, jsonb) from public, anon, authenticated;

-- The actor's display label, resolved the same way get_duel_push_target does.
create or replace function public.duel_actor_label(p_user_id uuid)
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

revoke all on function public.duel_actor_label(uuid) from public, anon, authenticated;

-- INVITE: a new pending participant row means somebody was just challenged.
create or replace function public.notify_duel_invite()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor text;
  v_tok   text;
begin
  if new.status is distinct from 'pending' then return new; end if;

  select duel_actor_label(c.challenger_id) into v_actor
  from challenges c where c.id = new.challenge_id;
  if v_actor is null then return new; end if;

  for v_tok in
    select pt.expo_push_token
    from push_tokens pt
    where pt.user_id = new.user_id
      and pt.expo_push_token is not null
      -- Same per-user opt-out the client path honoured. A server-side send
      -- must not quietly become a way around a user's notification setting.
      and pt.duel_notifications_enabled = true
  loop
    perform push_expo_message(
      v_tok,
      'Duel Invite',
      v_actor || ' is challenging you to a duel. Accept or decline?',
      jsonb_build_object('type', 'duel', 'challengeId', new.challenge_id)
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_notify_duel_invite on public.challenge_participants;
create trigger trg_notify_duel_invite
  after insert on public.challenge_participants
  for each row execute function public.notify_duel_invite();

-- ACCEPT: pending -> active on a non-creator row means the invitee said yes.
-- Told to the CREATOR, matching the old 'accepted' event exactly.
create or replace function public.notify_duel_accepted()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor       text;
  v_creator_id  uuid;
  v_tok         text;
begin
  -- Only the genuine pending -> active transition, and never the creator's
  -- own row (create_challenge inserts that one straight to 'active', so it
  -- never transitions and can never fire this).
  if old.status is not distinct from new.status then return new; end if;
  if new.status is distinct from 'active' then return new; end if;
  if old.status is distinct from 'pending' then return new; end if;
  if new.is_creator then return new; end if;

  select cp.user_id into v_creator_id
  from challenge_participants cp
  where cp.challenge_id = new.challenge_id and cp.is_creator = true
  limit 1;
  if v_creator_id is null or v_creator_id = new.user_id then return new; end if;

  v_actor := duel_actor_label(new.user_id);
  if v_actor is null then return new; end if;

  for v_tok in
    select pt.expo_push_token
    from push_tokens pt
    where pt.user_id = v_creator_id
      and pt.expo_push_token is not null
      and pt.duel_notifications_enabled = true
  loop
    perform push_expo_message(
      v_tok,
      'Duel Accepted',
      v_actor || ' accepted your duel — your move',
      jsonb_build_object('type', 'duel', 'challengeId', new.challenge_id)
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_notify_duel_accepted on public.challenge_participants;
create trigger trg_notify_duel_accepted
  after update on public.challenge_participants
  for each row execute function public.notify_duel_accepted();

commit;
