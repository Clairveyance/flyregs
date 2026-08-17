-- Found investigating bug #4 (Duel question swapping on return), 2026-08-16:
-- while confirming get_next_challenge_question is the only source of "the
-- current question" (it is, and is provably deterministic -- see
-- scripts/duel_e2e_test.py's scenario_resume), reviewed every RLS policy
-- touching Duels for the mandated gating/perms pass. challenge_participants
-- and challenges both carry `FOR ALL USING (...)` policies with NO business
-- rule beyond row ownership -- no Premium check, no "was actually invited"
-- check, no status-transition check. Every real write to these two tables
-- goes through create_challenge/respond_to_challenge/hide_challenge_from_
-- history/finalize_challenge_if_done, all SECURITY DEFINER (confirmed via
-- pg_proc.prosecdef), which bypass RLS entirely -- these ALL policies were
-- never meant to authorize direct client writes at all, just SELECT.
--
-- Live-tested whether this is actually exploitable today: a disposable
-- non-Premium invitee's own JWT attempted a raw PostgREST PATCH flipping
-- their own challenge_participants.status from 'pending' straight to
-- 'active' (bypassing respond_to_challenge's Premium gate entirely), and a
-- separate uninvited account attempted a raw INSERT joining an existing
-- duel as a participant with no invite at all. Both got HTTP 403 -- blocked
-- one layer down, by GRANT (authenticated/anon hold SELECT/REFERENCES/
-- TRIGGER only on these 4 tables, no INSERT/UPDATE/DELETE) -- not by RLS.
-- So there is no live bypass today, but the RLS policy is a bare-ownership
-- check with zero of create_challenge/respond_to_challenge's real business
-- rules re-expressed in it -- exactly the kind of gap this project has
-- shipped exploitable before (see migrations_fix_gating_audit_2026_08_14.sql,
-- same tables) the moment anyone "helpfully" adds the missing GRANTs
-- without separately re-deriving the RLS rules from scratch. Narrowing both
-- to SELECT-only removes that latent trap at zero functional cost -- every
-- legitimate write already goes through a SECURITY DEFINER function, which
-- runs as the function owner and needs neither the GRANT nor a passing RLS
-- check on the underlying table. Re-ran the full duel_e2e_test.py suite
-- (all scenarios) after this change with no new failures.
drop policy if exists challenge_participants_own_rows on challenge_participants;
create policy challenge_participants_own_rows on challenge_participants
  for select using (user_id = auth.uid());

drop policy if exists challenges_participants on challenges;
create policy challenges_participants on challenges
  for select using (
    exists (select 1 from challenge_participants cp where cp.challenge_id = challenges.id and cp.user_id = auth.uid())
  );
