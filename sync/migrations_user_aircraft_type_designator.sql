-- Adds an optional FAA type-certificate designator to user_aircraft,
-- separate from the free-text `model` (marketing name) field. AD
-- applicability text is written against the type designator ("PA-28-181",
-- "LA-4-200"), not marketing names ("Warrior", "Buccaneer") -- see
-- src/lib/aircraftModels.ts for the alias bridge that suggests this value,
-- and scripts/send-ad-alerts.mjs for the matching logic that now checks it
-- alongside `model`.
alter table public.user_aircraft
  add column if not exists type_designator text;
