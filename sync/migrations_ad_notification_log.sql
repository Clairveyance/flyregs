-- ============================================================================
-- AD notification delivery log  --  2026-07-31
--
-- Real gap found while auditing pipeline reliability (RC: "if a owner finds
-- out an AD was released on their a/c which they had listed on our app, and
-- the app didn't show or notify of that AD, we lose that customer, but all
-- their friends"): send-ad-alerts.mjs already matched ADs against saved
-- aircraft and sent real pushes, but wrote NO durable record of who was
-- matched, whether their push actually delivered, or whether they ever saw
-- it. A failed Expo push, or a user who simply never opened the app, was
-- indistinguishable after the fact from "the system never tried" -- the
-- only evidence was an ephemeral CI log line nobody watches proactively.
--
-- This table is the fix: one row per (aircraft, AD) match, independent of
-- whether the user has an enabled push token -- so the in-app "new AD in
-- your aircraft folder" marker works for every matched aircraft, not just
-- ones with a working push subscription (push delivery is layered on top
-- of this, not a precondition for it). `read_at` backs the unread-dot UI
-- RC asked for directly ("it should get placed into that folder right away
-- with the small blue dot next to it until read/opened").
-- ============================================================================

create table if not exists public.user_ad_notifications (
  id                bigserial primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  user_aircraft_id  uuid not null references public.user_aircraft(id) on delete cascade,
  ad_number         text not null,
  -- Which match rule fired -- airframe (make/model/type_designator) or
  -- tagged equipment (a part mentioned in the AD's applicability text).
  -- Informational only, not exclusive -- a match can satisfy both.
  matched_via       text not null default 'airframe' check (matched_via in ('airframe', 'equipment')),
  -- Populated only when the user had an enabled push token at send time.
  -- NULL push_status means no token existed -- the aircraft-folder marker
  -- still fires, there was just nothing to push to.
  push_status       text check (push_status in ('sent', 'error')),
  push_error        text,
  push_sent_at      timestamptz,
  read_at           timestamptz,
  created_at        timestamptz not null default now(),
  -- One row per (aircraft, AD) -- re-running the sync for the same
  -- already-touched AD must not create duplicate folder entries or reset
  -- an already-read notification back to unread.
  unique (user_aircraft_id, ad_number),
  -- Real FK (not just the ad_number column existing) is what lets
  -- PostgREST embed `airworthiness_directives(...)` directly off a
  -- user_ad_notifications select -- confirmed by checking how
  -- ad_part_mentions already does the same embed successfully.
  foreign key (ad_number) references airworthiness_directives(ad_number) on delete cascade
);

create index if not exists user_ad_notifications_user_idx
  on public.user_ad_notifications (user_id);
create index if not exists user_ad_notifications_aircraft_unread_idx
  on public.user_ad_notifications (user_aircraft_id, read_at);

grant select, update on public.user_ad_notifications to authenticated;

alter table public.user_ad_notifications enable row level security;

drop policy if exists user_ad_notifications_select_own on public.user_ad_notifications;
create policy user_ad_notifications_select_own on public.user_ad_notifications
  for select using (auth.uid() = user_id);

-- Only read_at is ever client-writable (marking a notification seen) --
-- everything else is written by the service-role sync job.
drop policy if exists user_ad_notifications_update_own on public.user_ad_notifications;
create policy user_ad_notifications_update_own on public.user_ad_notifications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
