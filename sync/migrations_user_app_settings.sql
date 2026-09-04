-- Settings and selections travel between a user's devices, when Back-up &
-- Sync is on.
--
-- RC, 2026-09-04: "yes, make the settings and selections travel too - IF
-- bu/s is ON."
--
-- The two-device parity test measured exactly what did and did not cross.
-- Folders, bookmarks, highlights and notes crossed; My Fleet, study progress,
-- duels, coins and the callsign crossed without any toggle because they live
-- only in Postgres. What did NOT cross was every preference: appearance, Red
-- Shift, text size, badge duration, study session size, study card direction.
-- Those live in device storage and nothing carried them.
--
-- WHY KEY/VALUE RATHER THAN A COLUMN PER SETTING
-- A settings table with one column per preference needs a migration, a view
-- change and a client change every time a preference is added, and the three
-- drift. This project has already been bitten by exactly that shape (see the
-- quizzable_* views and the study_facts CHECK constraint). A key/value row
-- per setting means a new preference is one line in the client's allow-list
-- and nothing else, and the allow-list is what stops it becoming a dumping
-- ground.
--
-- WHY updated_at PER ROW, NOT PER USER
-- Last-writer-wins has to be decided per setting. If the phone changes the
-- theme and the iPad changes the text size, a per-user timestamp makes one
-- of those changes lose for no reason. Per row, both survive.
--
-- Values are TEXT and the client owns their meaning. Nothing here is read by
-- the server, so there is no reason to teach the database about theme modes.

create table if not exists public.user_app_settings (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  key        text        not null,
  value      text,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.user_app_settings enable row level security;

drop policy if exists user_app_settings_own_rows on public.user_app_settings;
create policy user_app_settings_own_rows on public.user_app_settings
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Deliberately no anon grant: a signed-out device has no settings to sync,
-- and its local ones keep working exactly as before.
revoke all on public.user_app_settings from anon;
grant select, insert, update, delete on public.user_app_settings to authenticated;

-- A user's whole settings set is read in one go on every pull, so the
-- primary key already serves it. No extra index earns its keep here.

comment on table public.user_app_settings is
  'Per-user app preferences that travel between devices when Back-up & Sync '
  'is on. Key/value so a new preference needs no migration; the client owns '
  'the meaning of every value and the server never reads them.';
