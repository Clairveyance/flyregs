-- ============================================================================
-- Disclaimer acknowledgment log  --  2026-08-07
--
-- RC, re: My Fleet's AD-tracking disclaimer: "at least there, by them
-- clicking 'I understand' we have documentation that made it clear and
-- they acknowledged... can we log that acceptance somehow? for legal/
-- liability reasons?"
--
-- InfoPopup's forceOnce mechanism (src/components/InfoPopup.tsx) already
-- only ever shows an "I Understand" gate for content its own doc comment
-- calls out as carrying real liability weight -- every forceOnce id is
-- exactly this kind of disclaimer, not just the AD-tracking one. Logging
-- server-side (not just the existing local AsyncStorage "seen" flag, which
-- proves nothing if the device is lost/reset/uninstalled) at the component
-- level means every current AND future forceOnce disclaimer gets a durable
-- acknowledgment record for free, with no special-casing per screen.
-- ============================================================================

create table if not exists public.disclaimer_acknowledgments (
  id               bigserial primary key,
  user_id          uuid not null references auth.users(id) on delete cascade,
  -- Matches InfoPopup's own `id` prop verbatim (e.g. 'my-aircraft-intro') --
  -- one row per (user, disclaimer), re-acknowledging is a no-op upsert, not
  -- a new row every time the same forceOnce popup somehow re-shows.
  disclaimer_id    text not null,
  acknowledged_at  timestamptz not null default now(),
  unique (user_id, disclaimer_id)
);

alter table public.disclaimer_acknowledgments enable row level security;

-- A user can see and write only their own acknowledgment rows -- this is a
-- personal consent record, not shared/aggregate data.
create policy "own acknowledgments select" on public.disclaimer_acknowledgments
  for select using (auth.uid() = user_id);

create policy "own acknowledgments upsert" on public.disclaimer_acknowledgments
  for insert with check (auth.uid() = user_id);

create policy "own acknowledgments update" on public.disclaimer_acknowledgments
  for update using (auth.uid() = user_id);

create index if not exists idx_disclaimer_ack_user on public.disclaimer_acknowledgments(user_id);

-- RLS policies alone grant nothing -- Postgres checks table-level GRANTs
-- FIRST and RLS only narrows from there. Missing this exact grant is a
-- recurring gotcha in this codebase (see gotcha_search_ads_dictionary_permission_denied.md);
-- caught here live via a direct REST call returning 42501 "permission
-- denied" before this line was added.
grant select, insert, update on public.disclaimer_acknowledgments to authenticated;
grant usage, select on sequence public.disclaimer_acknowledgments_id_seq to authenticated;
