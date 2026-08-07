-- RC's recurring-AD/hobbs design (approved 2026-08-07): some ADs and
-- reminders aren't calendar-interval-based -- they recur on engine/airframe
-- usage (100-hour, TBO, etc). This adds a self-reported "current hours"
-- value on the aircraft (defaults to aircraft-level per RC's explicit
-- confirmation) and an optional "due at X hours" value on a reminder, so the
-- app can show a live "X hrs remaining" / "OVERDUE by X hrs" comparison.
-- v1 is manual-reset only (RC: "yes manual reset of that 'usage based'
-- tracking is fine for now") -- no auto-generated future cycles; the user
-- updates current_hobbs_hours themselves after logging time, and resets a
-- reminder's due_hobbs_hours themselves after complying.
ALTER TABLE user_aircraft ADD COLUMN IF NOT EXISTS current_hobbs_hours numeric NULL;
ALTER TABLE user_aircraft ADD COLUMN IF NOT EXISTS hobbs_updated_at timestamptz NULL;
ALTER TABLE user_aircraft_reminders ADD COLUMN IF NOT EXISTS due_hobbs_hours numeric NULL;
