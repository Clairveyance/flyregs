-- fleet_visible_cap(): distinguish "not signed in" from "no entitlement row".
--
-- The fail-open on a missing row is deliberate and stays -- a sync hiccup
-- must never make a paying customer's fleet look deleted. But anon has no
-- row for a different reason (there's no user at all), and the function was
-- handing it the same uncapped answer. Harmless in practice, since
-- user_aircraft is RLS'd to its owner and an anon caller can't see a row to
-- cap, but the tier matrix showed anon reading "unlimited" next to free's
-- "0", which is a misleading signal to debug against later.
CREATE OR REPLACE FUNCTION public.fleet_visible_cap()
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select case
    -- Not signed in at all -> nothing to show. Distinct from the
    -- missing-row case below, which is a PAYING user we must not punish.
    when auth.uid() is null then 0
    -- No entitlement row for a real signed-in user -> uncapped,
    -- deliberately: a sync hiccup must never make a paying customer's
    -- fleet look deleted. The client's own RevenueCat check covers that
    -- window.
    when not exists (select 1 from user_entitlements e where e.user_id = auth.uid())
      then 2147483647
    when coalesce((select e.is_premium from user_entitlements e where e.user_id = auth.uid()), false)
      then 2147483647   -- Premium: unlimited
    when coalesce((select e.is_pro from user_entitlements e where e.user_id = auth.uid()), false)
      then 1            -- Pro: exactly one
    else 0              -- Free / Plus: My Aircraft isn't part of the tier
  end;
$function$;
