-- Make server-side push failures VISIBLE.
--
-- Moving the invite pushes into the database (migrations_duel_push_server_side
-- / migrations_collab_invite_push_server_side) fixed delivery, and would have
-- recreated the exact blindness it was meant to cure if it stopped there:
-- pg_net files every response in net._http_response and nothing reads it.
--
-- This is not hypothetical. Proven live 2026-09-05 with a deliberately invalid
-- token: the folder-invite trigger fired, Expo answered
--
--   HTTP 200  {"data":{"status":"error","message":"\"ExponentPushToken[...]\"
--              is not a registered push notification recipient...",
--              "details":{"error":"DeviceNotRegistered"}}}
--
-- A 200 whose body says the push was never delivered. That is the same trap
-- the client sender fell into for months, and it is why RC could report "there
-- is zero notification" with nothing anywhere to corroborate it.
--
-- pg_net also PRUNES net._http_response (rows live ~6 hours), so a nightly
-- look would miss most of it. This copies failures out hourly into a table
-- that keeps them.

begin;

create table if not exists public.push_delivery_failures (
  id            bigserial primary key,
  response_id   bigint unique,          -- net._http_response.id, so one row per response
  status_code   int,
  error_code    text,                   -- e.g. DeviceNotRegistered
  message       text,
  expo_token    text,
  observed_at   timestamptz not null default now()
);

alter table public.push_delivery_failures enable row level security;
-- No policy: nothing in the app reads this. It exists for the scheduled
-- health check and for a human reading the DB.
revoke all on public.push_delivery_failures from anon, authenticated;

create index if not exists idx_push_delivery_failures_observed
  on public.push_delivery_failures (observed_at desc);

create or replace function public.harvest_push_delivery_failures()
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_new int;
  v_transport int;
begin
  -- NO join to net.http_request_queue. pg_net DELETES the queue row the moment
  -- the response is stored -- verified live: net._http_response had the failed
  -- Expo response while net.http_request_queue was completely empty -- so a
  -- join to it matches nothing, always, and this whole harvest silently
  -- collected zero rows. That is the same "scheduled job reports success and
  -- does nothing" failure this project has already been bitten by five times,
  -- and it is why this function was run and its output checked rather than
  -- scheduled and assumed.
  --
  -- Expo responses are identified by their own shape instead: a push send
  -- always answers with data.status ('ok' | 'error'), single or batched.
  insert into push_delivery_failures (response_id, status_code, error_code, message, expo_token)
  select r.id,
         r.status_code,
         t.item -> 'details' ->> 'error',
         coalesce(t.item ->> 'message', left(r.content, 400)),
         t.item -> 'details' ->> 'expoPushToken'
  from net._http_response r
  cross join lateral (
    select case
             when jsonb_typeof(r.content::jsonb -> 'data') = 'array'
               then r.content::jsonb -> 'data'
             when r.content::jsonb ? 'data'
               then jsonb_build_array(r.content::jsonb -> 'data')
             else '[]'::jsonb
           end as items
  ) x
  cross join lateral jsonb_array_elements(x.items) as t(item)
  where r.content is not null
    and r.content ~ '^\s*\{'
    and (r.content::jsonb -> 'data') is not null
    and (t.item ->> 'status') = 'error'
  on conflict (response_id) do nothing;

  get diagnostics v_new = row_count;

  -- Transport-level failures (timeout, DNS, a non-2xx) never produce a ticket
  -- at all, so they need their own pass or they would go unrecorded.
  insert into push_delivery_failures (response_id, status_code, error_code, message)
  select r.id, r.status_code,
         case when r.timed_out then 'Timeout' else 'HttpError' end,
         coalesce(r.error_msg, left(r.content, 400), 'no response body')
  from net._http_response r
  where (r.timed_out or r.status_code is null or r.status_code >= 300)
  on conflict (response_id) do nothing;

  get diagnostics v_transport = row_count;
  return v_new + v_transport;
end;
$$;

revoke all on function public.harvest_push_delivery_failures() from public, anon, authenticated;

select cron.unschedule('harvest-push-delivery-failures')
where exists (select 1 from cron.job where jobname = 'harvest-push-delivery-failures');

select cron.schedule(
  'harvest-push-delivery-failures',
  '7 * * * *',                                  -- hourly, well inside pg_net's ~6h retention
  $cron$ select public.harvest_push_delivery_failures(); $cron$
);

commit;
