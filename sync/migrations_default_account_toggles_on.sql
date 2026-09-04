-- Account toggles default ON for new users.
--
-- RC, 2026-09-04: "we want all account toggles ON by default. we want users to
-- get updates, DR, DW, and be seen in the app, so default is on and they can
-- turn off anytime."
--
-- WHERE THE REAL DEFAULT LIVES differs per table, and getting this wrong would
-- have looked done while changing nothing:
--
--   * push_tokens -- the CLIENT writes explicit values on registration
--     (notifications.ts's `prior?.x ?? false`), so the column default never
--     applied on the real path. That is fixed in the client in the same
--     change; these column defaults are updated too so a server-side insert
--     agrees rather than quietly re-introducing OFF.
--   * user_streaks -- rows are created by record_study_review with no explicit
--     values, so the COLUMN DEFAULT is genuinely the default a user gets.
--     This is the load-bearing half.
--
-- ONLY affects rows created from here on. Existing users keep whatever they
-- have, which is deliberate: a boolean cannot distinguish "never touched it"
-- from "deliberately turned it off", and silently re-enabling notifications or
-- public visibility for someone who opted out would be a real breach of trust.
-- Any backfill is RC's explicit call, not a side effect of this.
--
-- Note stats_visible/leaderboard_opt_in are VISIBILITY, not notifications:
-- defaulting them on means a new user appears on the leaderboard and in Find
-- Friends. That is what RC asked for ("be seen in the app"), and both remain
-- one tap to turn off in Account.

alter table public.push_tokens  alter column reg_of_day_enabled         set default true;
alter table public.push_tokens  alter column word_of_day_enabled        set default true;
alter table public.push_tokens  alter column duel_notifications_enabled set default true;
-- push_tokens.enabled is already `default true`.

alter table public.user_streaks alter column leaderboard_opt_in set default true;
alter table public.user_streaks alter column stats_visible      set default true;
