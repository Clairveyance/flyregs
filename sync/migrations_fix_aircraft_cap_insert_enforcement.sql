-- Fix: user_aircraft had zero INSERT-time cap enforcement. The 2026-08-05
-- tier-cap-enforcement pass (migrations_tier_cap_enforcement.sql) correctly
-- fixed the READ side (get_fleet_summary hides over-cap aircraft, all-or-
-- nothing, non-destructive) but never stopped a caller from creating MORE
-- aircraft than fleet_visible_cap() allows in the first place -- confirmed
-- live via the 2026-08-10 tier-gate audit: a Pro-tier account (cap=1) could
-- INSERT a 2nd and 3rd aircraft directly via REST, all succeeding.
--
-- Real-world exposure is bounded -- AircraftDowngradeGate (mounted at root)
-- intercepts with a blocking lockout modal the instant the account opens any
-- screen, and get_fleet_summary/get_fleet_hidden_count already correctly
-- hide/report the overage -- but a caller that only ever talks to the API
-- and never opens the app's UI could keep adding aircraft indefinitely.
--
-- Mirrors enforce_aircraft_share_premium's existing BEFORE-trigger pattern.
-- Reuses fleet_visible_cap() directly rather than re-deriving the tier
-- logic, so the fail-open behavior for a missing user_entitlements row (a
-- sync hiccup must never lock a paying customer out of adding their first
-- aircraft) stays in exactly one place.

CREATE OR REPLACE FUNCTION public.enforce_aircraft_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF (SELECT count(*) FROM user_aircraft WHERE user_id = NEW.user_id) >= public.fleet_visible_cap() THEN
    RAISE EXCEPTION 'Aircraft limit reached for your current plan';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_aircraft_cap ON public.user_aircraft;
CREATE TRIGGER trg_enforce_aircraft_cap
  BEFORE INSERT ON public.user_aircraft
  FOR EACH ROW EXECUTE FUNCTION public.enforce_aircraft_cap();
