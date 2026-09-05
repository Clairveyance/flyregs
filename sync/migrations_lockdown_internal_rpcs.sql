-- Two SECURITY DEFINER functions were callable by ANYONE holding the public
-- app key, including with no account at all.
--
-- FOUND AND PROVEN LIVE 2026-09-05 (whole-app sweep), using nothing but
-- EXPO_PUBLIC_SUPABASE_ANON_KEY -- the key that ships inside every build:
--
--   POST /rest/v1/rpc/refresh_search_popularity     -> HTTP 204
--   POST /rest/v1/rpc/finalize_challenge_if_done    -> HTTP 200
--
-- refresh_search_popularity() runs FOURTEEN full-table UPDATEs across the
-- entire corpus -- advisory_circulars, far_sections, aim_paragraphs,
-- pcg_terms, cfr49_sections, airworthiness_directives,
-- legal_interpretations -- zeroing then recomputing search_popularity on
-- every row. It exists to be run once a day by pg_cron. Unauthenticated, in
-- a loop, it is a write-amplification and cost attack on the database, and
-- it needs no account, no email, and no rate limit to reach.
--
-- finalize_challenge_if_done(uuid) closes a duel: it settles winners, writes
-- user_duel_stats and awards coins. Any anonymous caller could invoke it
-- against any challenge id -- state change on somebody else's game by a
-- party with no relationship to it.
--
-- Neither has ever been called from client code. Checked properly before
-- revoking anything, because a revoke that breaks the SHIPPED build is worse
-- than the hole (see gotcha_rls_fix_broke_shipped_build):
--
--   git log --all -S"'finalize_challenge_if_done'" -- src/   ->  0 commits
--   git log --all -S"'refresh_search_popularity'"  -- src/   ->  0 commits
--
-- And both keep working for their real callers: finalize_challenge_if_done is
-- invoked from inside forfeit_challenge, submit_challenge_answer and
-- expire_stale_challenges, all SECURITY DEFINER, which execute as the owner
-- and therefore do not consult the caller's EXECUTE privilege at all;
-- refresh_search_popularity is invoked by pg_cron as postgres.
--
-- Everything else on the anon-executable list was checked and left alone:
-- the pure text/level helpers compute from their arguments and hold nothing,
-- the has_*/is_* predicates are used INSIDE policy expressions and are
-- evaluated as the caller (so revoking them would break RLS itself), and
-- get_shared_*_preview is deliberately anon-callable -- it is what the invite
-- landing page shows before you sign in.

begin;

revoke execute on function public.refresh_search_popularity() from public, anon, authenticated;
revoke execute on function public.finalize_challenge_if_done(uuid) from public, anon, authenticated;

commit;
