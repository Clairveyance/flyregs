-- Tier-cap enforcement for saved aircraft (RC, 2026-08-05).
--
-- RC, on a Pro-tier screenshot showing four aircraft: "a Pro user would
-- never get a note about 'tracking 4 a/c' b/c that's not possible with
-- Pro. so this whole system needs to be fixed, all gates checked, all
-- perms. we can't have any bleed through."
--
-- He's right, and it was worse than a copy bug. PRO_AIRCRAFT_CAP was only
-- ever enforced at CREATE time (my-aircraft/index.tsx's handleAdd) and
-- never at READ time, so an account that downgrades Premium -> Pro keeps
-- every aircraft it ever saved: fully visible, fully functional, and --
-- the part that actually reaches the user's pocket -- still generating AD
-- push alerts for all of them (send-ad-alerts.mjs matched every
-- user_aircraft row with no tier check at all). Confirmed live, not
-- theorized: the one account in this project with saved aircraft has
-- user_entitlements.is_premium = false and four saved aircraft.
--
-- The cap is now enforced where the data is READ, in three layers that
-- each independently close it:
--   1. here, server-side, so it holds no matter what client asks;
--   2. the client's own isPremium check (my-aircraft/index.tsx), which
--      covers the window where a real Premium user's entitlement row
--      hasn't synced yet;
--   3. send-ad-alerts.mjs, so hidden aircraft can't push notifications.
--
-- Deliberately NON-destructive: over-cap aircraft are hidden, never
-- deleted. Re-subscribing to Premium brings them all straight back, and
-- get_fleet_hidden_count() below is what lets the UI say so honestly
-- instead of a downgraded user silently "losing" data.
--
-- Fail-safe direction: capping only kicks in when user_entitlements
-- actually says not-premium. A MISSING row is treated as uncapped, on
-- purpose -- a sync hiccup must never make a paying customer's fleet
-- appear to vanish, and layer 2 above still holds that case.

-- Non-Premium ceiling on saved aircraft. Mirrors PRO_AIRCRAFT_CAP in
-- src/app/my-aircraft/index.tsx -- keep the two in step.
CREATE OR REPLACE FUNCTION public.fleet_visible_cap()
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select case
    when coalesce((select e.is_premium from user_entitlements e where e.user_id = auth.uid()), true)
      then 2147483647   -- Premium (or entitlement not yet synced): uncapped
    else 1              -- Pro and below: PRO_AIRCRAFT_CAP
  end;
$function$;

CREATE OR REPLACE FUNCTION public.get_fleet_summary()
 RETURNS TABLE(out_aircraft_id uuid, out_make text, out_model text, out_nickname text, out_type_designator text, out_year integer, out_role text, out_open_ad_count integer, out_overdue_reminder_count integer)
 LANGUAGE sql
 STABLE
AS $function$
  with mine as (
    select ua.id, ua.make, ua.model, ua.nickname, ua.type_designator, ua.year, ua.created_at,
      case when ua.user_id = auth.uid() then 'owner' else ac.role end as role,
      (ua.user_id = auth.uid()) as is_owned
    from user_aircraft ua
    left join aircraft_collaborators ac on ac.aircraft_id = ua.id and ac.user_id = auth.uid() and ac.left_at is null
    where ua.user_id = auth.uid() or ac.user_id = auth.uid()
  ),
  visible as (
    -- Owned aircraft, oldest first, capped. "Oldest" is the one deliberate
    -- choice here: it's stable (a new save can never bump an existing one
    -- out of view) and it keeps the aircraft the user has had longest,
    -- which for the overwhelmingly common case -- one aircraft, always the
    -- same one -- is simply "theirs."
    select m.id, m.make, m.model, m.nickname, m.type_designator, m.year, m.role
    from (
      select m2.*, row_number() over (order by m2.created_at asc, m2.id asc) as rn
      from mine m2 where m2.is_owned
    ) m
    where m.rn <= public.fleet_visible_cap()
    union all
    -- Shared-in aircraft are a Premium capability in both directions, so
    -- they're all-or-nothing rather than part of the count: a non-Premium
    -- account sees none of them (the cap function returns 1 only for
    -- non-Premium, and int-max otherwise, so this predicate reads as
    -- "Premium only" without a second entitlement lookup).
    select m.id, m.make, m.model, m.nickname, m.type_designator, m.year, m.role
    from mine m
    where not m.is_owned and public.fleet_visible_cap() > 1
  )
  select
    v.id, v.make, v.model, v.nickname, v.type_designator, v.year, v.role,
    coalesce((select count(*)::int from user_ad_notifications n where n.user_aircraft_id = v.id and n.dismissed_at is null and n.complied_at is null), 0),
    coalesce((select count(*)::int from user_aircraft_reminders r where r.user_aircraft_id = v.id and r.due_date < current_date), 0)
  from visible v
  order by v.make, v.model;
$function$;

-- How many of this user's aircraft the cap is currently hiding. Drives the
-- honest "N more saved, hidden on Pro" notice instead of them just being
-- gone. Returns 0 for Premium and for anyone at or under the cap.
CREATE OR REPLACE FUNCTION public.get_fleet_hidden_count()
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select greatest(
    (
      select count(*)::int
      from user_aircraft ua
      left join aircraft_collaborators ac on ac.aircraft_id = ua.id and ac.user_id = auth.uid() and ac.left_at is null
      where ua.user_id = auth.uid() or ac.user_id = auth.uid()
    ) - (select count(*)::int from public.get_fleet_summary()),
    0
  );
$function$;

GRANT EXECUTE ON FUNCTION public.fleet_visible_cap() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_fleet_hidden_count() TO authenticated;
