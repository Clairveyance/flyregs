-- Adds a manufacture-year field to user_aircraft -- RC: "the My a/c box,
-- we could have a few more 'identifiers' per a/c - make, model, type,
-- nickname, year, etc." Nullable, no validation range enforced here (the
-- client-side year picker already bounds it to a sane range) -- this is
-- user-entered identifying info, never independently verified, same
-- posture as every other My Aircraft field (see that screen's own
-- disclaimer card).
alter table public.user_aircraft
  add column if not exists year integer;
