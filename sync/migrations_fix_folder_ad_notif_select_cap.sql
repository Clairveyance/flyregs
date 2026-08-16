-- Fixes 2 of the 3 RLS gaps flagged (policy-read only, not yet live-tested)
-- by the B34 readiness tier-gate audit, now live-confirmed real with
-- scripts/three_gap_rls_test.py. The third flagged item,
-- user_aircraft_reminders, turned out to be a false positive: its SELECT
-- policy's EXISTS subquery against user_aircraft now inherits the cap
-- check added by migrations_fix_user_aircraft_select_returning.sql for
-- free, since that subquery is itself subject to user_aircraft's own
-- (now-fixed) SELECT policy. Confirmed live -- no separate fix needed
-- there.
--
-- 1) synced_folders: folders_own_select was ownership-only, with no
--    folder_visible_cap() awareness -- confirmed live, a user downgraded
--    to Free (cap 0) still read all their folders via a direct table
--    query. Same shape as the user_aircraft bug, same fix approach.
--
--    Deliberately NOT reusing the existing is_folder_visible(p_folder_id)
--    (self-lookup-by-id, SECURITY DEFINER) here, even though today's only
--    write path (syncPushFolder's plain .upsert(), no .select()) doesn't
--    request RETURNING and so wouldn't currently hit the same trap
--    user_aircraft did. Using the row-values-direct pattern instead means
--    this policy stays safe even if a future .select() gets added to that
--    upsert call, matching the pattern already proven correct for
--    user_aircraft's own SELECT fix.
--
-- 2) user_ad_notifications: user_ad_notifications_select_own was
--    ownership-only, no tier/cap check at all -- confirmed live, a user
--    downgraded to Free (aircraft cap 0, all aircraft hidden) still read
--    every AD notification tied to their now-inaccessible aircraft.
--    Reusing the existing is_aircraft_visible(id) unchanged here IS safe
--    (unlike the user_aircraft case) -- this function looks up a
--    DIFFERENT, already-existing user_aircraft row via the notification's
--    foreign key, not a self-referencing lookup on the table being
--    checked, so there's no same-statement RETURNING visibility trap
--    regardless of how notification rows get created.

create or replace function public.is_folder_visible_row(p_user_id uuid, p_sort_order integer, p_created_at timestamptz, p_id text)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select (
    select count(*) from public.synced_folders other
    where other.user_id = p_user_id
      and other.deleted = false
      and (coalesce(other.sort_order, 2147483647), other.created_at, other.id)
        < (coalesce(p_sort_order, 2147483647), p_created_at, p_id)
  ) < public.folder_visible_cap();
$$;

grant execute on function public.is_folder_visible_row(uuid, integer, timestamptz, text) to authenticated;

drop policy if exists folders_own_select on public.synced_folders;
create policy folders_own_select on public.synced_folders
  for select
  using (
    auth.uid() = user_id
    and (
      deleted = true
      or public.is_folder_visible_row(user_id, sort_order, created_at, id)
    )
  );

drop policy if exists user_ad_notifications_select_own on public.user_ad_notifications;
create policy user_ad_notifications_select_own on public.user_ad_notifications
  for select
  using (auth.uid() = user_id and public.is_aircraft_visible(user_aircraft_id));
