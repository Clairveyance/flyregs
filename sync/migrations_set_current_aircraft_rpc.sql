-- "Current aircraft" on the profile could never save.
--
-- Same root cause as the beta-tester report that produced set_streak_visibility
-- on 2026-09-02: `authenticated` holds only REFERENCES/SELECT/TRIGGER on
-- user_streaks, so a client upsert is rejected at the GRANT layer before RLS is
-- consulted. Two of the three writers were moved to an RPC that day;
-- setCurrentAircraft, three lines further down the same file, was missed. The
-- call site swallowed the throw, so the Save button just stayed dirty.
--
-- A SEPARATE function rather than extra parameters on set_streak_visibility,
-- deliberately: adding params would create an overload, and PostgREST cannot
-- disambiguate overloaded functions -- this project already has a documented
-- gotcha from exactly that (create_or_replace_signature_overload). A second
-- narrow function has no such trap and keeps each one obvious.
--
-- Still an RPC and not a table grant, for the same reason as before:
-- user_streaks also holds current_streak / longest_streak / last_active_date,
-- which back the Ready Room leaderboard. Client write access to the table would
-- make those forgeable. This touches exactly one column, on auth.uid()'s row.

create or replace function public.set_current_aircraft(p_aircraft text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.user_streaks (user_id, current_aircraft, updated_at)
  values (auth.uid(), nullif(left(btrim(coalesce(p_aircraft, '')), 40), ''), now())
  on conflict (user_id) do update set
    current_aircraft = nullif(left(btrim(coalesce(p_aircraft, '')), 40), ''),
    updated_at       = now();
end;
$$;

revoke execute on function public.set_current_aircraft(text) from public, anon;
grant  execute on function public.set_current_aircraft(text) to authenticated;
