-- Per-part maintenance tracking on user_aircraft_equipment, same shape as
-- user_aircraft_reminders' own due_date/due_hobbs_hours. RC: each equipment
-- "part box" needs its own input sheet for the specific date/hour
-- requirement of that part (e.g. "inspected every 100 hrs"), tracked right
-- on the part itself -- independent of the general Reminders list.
-- interval_hours is the recurrence ("every X hours"); due_hobbs_hours is
-- the next actual due mark (auto-computed client-side from the aircraft's
-- current_hobbs_hours + interval_hours when the part is added, but a plain
-- numeric column so the owner can freely override it with a custom start
-- point). due_date is an independent, optional calendar-based due mark --
-- a part can be tracked by hours, by date, by both, or by neither.
ALTER TABLE user_aircraft_equipment ADD COLUMN IF NOT EXISTS interval_hours numeric NULL;
ALTER TABLE user_aircraft_equipment ADD COLUMN IF NOT EXISTS due_hobbs_hours numeric NULL;
ALTER TABLE user_aircraft_equipment ADD COLUMN IF NOT EXISTS due_date date NULL;
