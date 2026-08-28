-- RC (2026-08-28, in-app feedback): "Reminders feature: add pre-populated
-- chips for pitot-static (24 cal. months, IFR) and VOR check (30 days,
-- IFR)." Pitot-static fits the existing calendar-MONTHS interval exactly
-- (14 CFR 91.411). VOR check's real interval is 30 CALENDAR DAYS (14 CFR
-- 91.171) -- not expressible in the existing `interval_months` column
-- without either rounding (silently wrong: a "1 month" label on a strict
-- 30-day currency requirement) or lying about the unit. Adds a parallel
-- interval_days column instead of overloading interval_months, so a
-- reminder recurs on EITHER a months basis OR a days basis, never both --
-- mirrors interval_months's own nullable, purely-informational shape (see
-- migrations_reminder_interval.sql), no schema change to any existing row's
-- behavior.
ALTER TABLE user_aircraft_reminders ADD COLUMN IF NOT EXISTS interval_days INTEGER NULL;

ALTER TABLE user_aircraft_reminders
  DROP CONSTRAINT IF EXISTS user_aircraft_reminders_one_interval_unit_check;
ALTER TABLE user_aircraft_reminders
  ADD CONSTRAINT user_aircraft_reminders_one_interval_unit_check
  CHECK (interval_months IS NULL OR interval_days IS NULL);
