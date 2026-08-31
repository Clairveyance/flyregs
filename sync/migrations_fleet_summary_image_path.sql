-- Aircraft photo, part 2: surface image_path through get_fleet_summary()
-- so the fleet list can show a real thumbnail instead of the generic
-- airplane icon. See migrations_user_aircraft_image.sql for the column and
-- storage bucket this depends on.
--
-- Postgres won't let CREATE OR REPLACE change the OUT-parameter row type at
-- all, even to only ever append a column -- confirmed live (42P13) rather
-- than assumed. DROP + CREATE instead; every existing column keeps its
-- name/type/order, so no client reading by name breaks.

drop function public.get_fleet_summary();

create function public.get_fleet_summary()
returns table(
  out_aircraft_id uuid, out_make text, out_model text, out_nickname text,
  out_type_designator text, out_year integer, out_role text,
  out_open_ad_count integer, out_compliant_ad_count integer,
  out_overdue_reminder_count integer, out_current_hobbs_hours numeric,
  out_image_path text
)
language sql
stable
as $function$
  with mine as (
    select ua.id, ua.make, ua.model, ua.nickname, ua.type_designator, ua.year, ua.created_at, ua.current_hobbs_hours, ua.image_path,
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
    select id, make, model, nickname, type_designator, year, role, current_hobbs_hours, image_path
    from ranked_owned
    where rn <= public.fleet_visible_cap()
    union all
    select m.id, m.make, m.model, m.nickname, m.type_designator, m.year, m.role, m.current_hobbs_hours, m.image_path
    from mine m
    where not m.is_owned and public.fleet_visible_cap() > 1
  )
  select
    v.id, v.make, v.model, v.nickname, v.type_designator, v.year, v.role,
    coalesce((select count(*)::int from user_ad_notifications n where n.user_aircraft_id = v.id and n.dismissed_at is null and n.complied_at is null), 0),
    coalesce((select count(*)::int from user_ad_notifications n where n.user_aircraft_id = v.id and n.dismissed_at is null and n.complied_at is not null), 0),
    coalesce((select count(*)::int from user_aircraft_reminders r where r.user_aircraft_id = v.id and r.due_date < current_date), 0),
    v.current_hobbs_hours,
    v.image_path
  from visible v
  order by v.make, v.model;
$function$;

-- The live grants on the OLD function (checked before dropping it, not
-- assumed) were postgres/service_role/authenticated/anon/PUBLIC EXECUTE --
-- the standard pre-lockdown CREATE FUNCTION default, since this function
-- predates migrations_close_public_schema_default_privileges.sql. That
-- lockdown only changed what NEW objects get by default (defaclacl for
-- functions created by `postgres` now grants EXECUTE to postgres/
-- service_role only) -- it does not retroactively touch existing grants,
-- but a fresh DROP + CREATE here is a brand-new object and WOULD silently
-- lose authenticated's access without this, breaking the feature for every
-- real user (confirmed by reading pg_default_acl before writing this, not
-- assumed). Granting to authenticated only, not anon/PUBLIC like the old
-- function had: this function does no auth.uid()-independent work for an
-- unauthenticated caller (every branch is scoped by RLS + auth.uid()), so
-- anon/PUBLIC execute was always functionally inert -- tightening it here
-- rather than reproducing a redundant grant is the same posture this
-- session's other fixes have already applied elsewhere tonight.
grant execute on function public.get_fleet_summary() to authenticated;

-- VERIFY: select out_aircraft_id, out_image_path from get_fleet_summary();
-- -- every existing column still present in the same order, new column
-- null for every aircraft until one is uploaded. Also re-run
-- scripts/aircraft_sharing_e2e_test.py in full -- it calls this RPC as a
-- real authenticated test account and would catch a missing grant
-- immediately as a 42501/permission-denied failure.
