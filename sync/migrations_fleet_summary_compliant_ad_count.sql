-- RC, real device, My Fleet: "the count up top isn't matching how many
-- open/compliant ADs there are... 12 open and 3 complied ADs, but the top
-- numbers don't match at all." Root cause: get_fleet_summary() only ever
-- returned open-AD-count and overdue-reminder-count -- there was no
-- compliant-AD count anywhere, so the client fell back to counting how many
-- AIRCRAFT (not ADs) fall into a "compliant" bucket (an aircraft with zero
-- open ADs and zero overdue reminders). With a 1-aircraft fleet that's
-- always 0 or 1, regardless of how many of that aircraft's real ADs are
-- actually marked complied -- exactly the mismatch reported. This adds the
-- missing item-level count so the client can show real numbers instead.
--
-- Same shape as out_open_ad_count (user_ad_notifications rows for this
-- aircraft, not dismissed) except requiring complied_at IS NOT NULL instead
-- of IS NULL -- the two counts are mutually exclusive by construction, no
-- double-counting possible.
-- Postgres won't let CREATE OR REPLACE change a function's OUT-parameter
-- shape (adding out_compliant_ad_count) -- must drop and recreate. Safe:
-- get_fleet_summary() takes no arguments, so there's no overload ambiguity,
-- and the GRANT below is re-issued explicitly rather than assumed to survive
-- the drop (a fresh CREATE FUNCTION does NOT inherit the old one's grants).
DROP FUNCTION IF EXISTS public.get_fleet_summary();

CREATE FUNCTION public.get_fleet_summary()
 RETURNS TABLE(out_aircraft_id uuid, out_make text, out_model text, out_nickname text, out_type_designator text, out_year integer, out_role text, out_open_ad_count integer, out_compliant_ad_count integer, out_overdue_reminder_count integer, out_current_hobbs_hours numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
    coalesce((select count(*)::int from user_ad_notifications n where n.user_aircraft_id = v.id and n.dismissed_at is null and n.complied_at is not null), 0),
    coalesce((select count(*)::int from user_aircraft_reminders r where r.user_aircraft_id = v.id and r.due_date < current_date), 0),
    v.current_hobbs_hours
  from visible v
  order by v.make, v.model;
$function$;

-- A fresh CREATE FUNCTION does not inherit the dropped one's grants --
-- reissuing explicitly rather than relying on Postgres's own PUBLIC-default
-- behavior. Matches the original grant set (confirmed via
-- information_schema.routine_privileges before this migration ran: PUBLIC,
-- anon, authenticated, service_role, postgres all had EXECUTE).
GRANT EXECUTE ON FUNCTION public.get_fleet_summary() TO PUBLIC;
