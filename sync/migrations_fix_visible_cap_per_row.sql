-- Fixes the "blunt aggregate cap" bug found while verifying the
-- 2026-08-14 synced_folder_items fix: has_visible_fleet_access() and
-- has_visible_folder_access() both compare a bare COUNT(*) against the
-- tier cap, with no awareness of WHICH row is being checked -- so the
-- moment a user's total count exceeds their cap by even one, every
-- write/read check involving those functions fails for EVERY row, not
-- just the excess ones. The client's own "which ones are visible" logic
-- (saved.tsx's `folders.slice(0, folderCap)` after sorting by
-- sort_order; my-aircraft/index.tsx's `all.slice(0, aircraftCap)`) is
-- genuinely per-row -- first N by a stable order stay usable, the rest
-- lock -- and the server-side checks need to match that, not just gate
-- on the aggregate.
--
-- WORSE THAN EXPECTED, found while writing this fix: get_fleet_summary()
-- (the actual READ path behind My Fleet) has the identical shape and is
-- not just a write-blocker -- `where m.is_owned and (select count(*)...)
-- <= fleet_visible_cap()` means a user 1 aircraft over their cap
-- currently sees ZERO owned aircraft in their fleet, not the first N
-- they're supposed to keep. This is the real, severe bug, not just the
-- write-path one -- confirmed by reading the live function definition
-- directly, not assumed. Fixed here too.
--
-- Both new helpers rank the caller's own rows by a stable order and
-- check whether THIS SPECIFIC row's rank is within cap -- created_at for
-- aircraft (the only stable signal get_fleet_summary() had), sort_order
-- for folders (matching saved.tsx's own sort exactly, with a fallback
-- for null sort_order so a never-reordered folder doesn't sort before
-- everything).

create or replace function public.is_aircraft_visible(p_aircraft_id uuid)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from (
      select id, row_number() over (order by created_at asc, id asc) as rn
      from user_aircraft
      where user_id = auth.uid()
    ) ranked
    where ranked.id = p_aircraft_id
      and ranked.rn <= public.fleet_visible_cap()
  );
$$;

grant execute on function public.is_aircraft_visible(uuid) to authenticated;

create or replace function public.is_folder_visible(p_folder_id text)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from (
      select id, row_number() over (order by coalesce(sort_order, 2147483647) asc, created_at asc, id asc) as rn
      from synced_folders
      where user_id = auth.uid() and deleted = false
    ) ranked
    where ranked.id = p_folder_id
      and ranked.rn <= public.folder_visible_cap()
  );
$$;

grant execute on function public.is_folder_visible(text) to authenticated;

-- Real fix: get_fleet_summary() returns the first N owned aircraft by
-- created_at, not zero, once total count exceeds cap. Column list,
-- shared-aircraft branch, and final select are otherwise byte-identical
-- to the live function this replaces (pulled via pg_get_functiondef
-- before writing this, not reconstructed from memory).
create or replace function public.get_fleet_summary()
returns table(out_aircraft_id uuid, out_make text, out_model text, out_nickname text, out_type_designator text, out_year integer, out_role text, out_open_ad_count integer, out_overdue_reminder_count integer, out_current_hobbs_hours numeric)
language sql stable
as $$
  with mine as (
    select ua.id, ua.make, ua.model, ua.nickname, ua.type_designator, ua.year, ua.created_at, ua.current_hobbs_hours,
      case when ua.user_id = auth.uid() then 'owner' else ac.role end as role,
      (ua.user_id = auth.uid()) as is_owned
    from user_aircraft ua
    left join aircraft_collaborators ac on ac.aircraft_id = ua.id and ac.user_id = auth.uid() and ac.left_at is null and ac.accepted_at is not null
    where ua.user_id = auth.uid() or (ac.user_id = auth.uid() and ac.accepted_at is not null)
  ),
  ranked_owned as (
    select m.*, row_number() over (order by m.created_at asc, m.id asc) as rn
    from mine m
    where m.is_owned
  ),
  visible as (
    select id, make, model, nickname, type_designator, year, role, current_hobbs_hours
    from ranked_owned
    where rn <= public.fleet_visible_cap()
    union all
    select m.id, m.make, m.model, m.nickname, m.type_designator, m.year, m.role, m.current_hobbs_hours
    from mine m
    where not m.is_owned and public.fleet_visible_cap() > 1
  )
  select
    v.id, v.make, v.model, v.nickname, v.type_designator, v.year, v.role,
    coalesce((select count(*)::int from user_ad_notifications n where n.user_aircraft_id = v.id and n.dismissed_at is null and n.complied_at is null), 0),
    coalesce((select count(*)::int from user_aircraft_reminders r where r.user_aircraft_id = v.id and r.due_date < current_date), 0),
    v.current_hobbs_hours
  from visible v
  order by v.make, v.model;
$$;

-- Swap the blunt aggregate checks for the per-row ones on all 3 affected
-- write policies. SELECT/DELETE stay untouched everywhere (unchanged
-- from the existing, already-correct "don't block cleanup" posture).
-- Postgres has no CREATE OR REPLACE POLICY -- drop-then-create.
DROP POLICY IF EXISTS folders_own_update ON public.synced_folders;
CREATE POLICY folders_own_update ON public.synced_folders
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND public.is_folder_visible(id));

DROP POLICY IF EXISTS owners_synced_folder_items_insert ON public.synced_folder_items;
CREATE POLICY owners_synced_folder_items_insert ON public.synced_folder_items
  FOR INSERT WITH CHECK (
    folder_owner_id(folder_id) = auth.uid()
    AND public.is_folder_visible(folder_id)
  );

DROP POLICY IF EXISTS owners_synced_folder_items_update ON public.synced_folder_items;
CREATE POLICY owners_synced_folder_items_update ON public.synced_folder_items
  FOR UPDATE
  USING (folder_owner_id(folder_id) = auth.uid())
  WITH CHECK (
    folder_owner_id(folder_id) = auth.uid()
    AND public.is_folder_visible(folder_id)
  );

DROP POLICY IF EXISTS user_aircraft_reminders_insert ON public.user_aircraft_reminders;
CREATE POLICY user_aircraft_reminders_insert ON public.user_aircraft_reminders
  FOR INSERT WITH CHECK (
    (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_reminders.user_aircraft_id AND ua.user_id = auth.uid()))
    AND has_pro_access(auth.uid())
    AND public.is_aircraft_visible(user_aircraft_id)
  );

DROP POLICY IF EXISTS user_aircraft_reminders_update ON public.user_aircraft_reminders;
CREATE POLICY user_aircraft_reminders_update ON public.user_aircraft_reminders
  FOR UPDATE
  USING (
    (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_reminders.user_aircraft_id AND ua.user_id = auth.uid()))
    AND has_pro_access(auth.uid())
  )
  WITH CHECK (
    (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_reminders.user_aircraft_id AND ua.user_id = auth.uid()))
    AND has_pro_access(auth.uid())
    AND public.is_aircraft_visible(user_aircraft_id)
  );
