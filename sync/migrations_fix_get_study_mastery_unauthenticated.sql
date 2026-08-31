-- ============================================================================
-- SECURITY (MEDIUM): get_study_mastery() returns ANY user's study progress --
-- and WRITES a row for them -- to an unauthenticated caller     2026-08-31
-- ============================================================================
--
-- NOT YET APPLIED. Found by the same B1 sweep as
-- migrations_close_anon_read_on_user_profile_tables.sql. Same bug class as
-- synced_bookmarks_gated (c564e4f): owner-rights execution (SECURITY DEFINER
-- here, security_invoker-off view there) over per-user data, with the gate
-- keyed to something other than the CALLER'S identity.
--
-- WHAT
-- ----
-- get_study_mastery(p_item_type text, p_user_id uuid) is SECURITY DEFINER and
-- EXECUTE-able by anon. It does:
--
--     v_uid uuid := coalesce(p_user_id, auth.uid());
--     if not public.has_pro_access(v_uid) then return; end if;
--
-- The tier check is on v_uid -- the TARGET user -- not on the caller, and
-- nothing checks that the caller is signed in at all. So passing an arbitrary
-- p_user_id reads that user's study_progress counts with no session.
--
-- Proven live, 2026-08-31, UNAUTHENTICATED (apikey header only):
--
--   POST /rest/v1/rpc/get_study_mastery
--   {"p_item_type":null,"p_user_id":"4fb26b2a-5aa5-435c-a5c4-cb27e7a3d6af"}
--   -> 200 [{"mastered":0,"seen":17,"total_available":12778,"pct":0}]
--
-- Worse than a read: the function also does an unconditional
--
--     insert into study_mastery_high_water (...) values (v_uid, ...)
--     on conflict (user_id, item_type) do update set best_pct = greatest(...)
--
-- so an unauthenticated caller can CREATE AND RATCHET rows in another user's
-- high-water table. study_mastery_high_water has RLS on with zero policies,
-- so it is unreachable directly -- this RPC is the only way in, and it is
-- open to the internet. The ratchet only ever moves upward via greatest(),
-- so the practical damage is inflating someone's best_pct, not destroying
-- data, but it is an unauthenticated write to another user's row either way.
--
-- The other anon-EXECUTE-able community RPCs were probed the same way and are
-- correctly fail-closed on the CALLER: get_visible_users, get_duels_
-- leaderboard, get_mastery_leaderboard and get_ready_room_leaderboard all
-- start with `has_pro_access()` (no argument = auth.uid()), which is false for
-- anon, and all returned []. get_challengeable_users and get_duel_stats
-- returned 400 "Duels requires Premium". get_study_mastery is the only one
-- that gates on the argument instead of the caller.
--
-- FIX
-- ---
-- One added guard: refuse when there is no session. Everything else in the
-- body is copied VERBATIM from the live definition (pg_get_functiondef,
-- 2026-08-31) -- do not "tidy" it.
--
-- CREATE OR REPLACE with the IDENTICAL signature (both defaults included) so
-- this replaces the function rather than adding an overload -- see
-- memory/gotcha_create_or_replace_signature_overload.md.
--
-- SHIPPED-BUILD RISK: checked, LOW. There are three call sites and all three
-- require a session:
--   src/app/study.tsx:226,383            getStudyMastery()        (own, session)
--   src/app/(tabs)/search.tsx:237        getStudyMastery()        (own, session)
--   src/app/profile/[userId].tsx:358     getStudyMastery(userId)  (other pilot,
--                                        Community profile page, session)
-- The p_user_id path is a real shipped feature (another pilot's mastery on the
-- Community profile page) and is deliberately LEFT WORKING for signed-in
-- callers -- this guard only rejects callers with no session at all.
--
-- NOT DONE HERE, ON PURPOSE -- product decision for RC, and it WOULD change
-- what real users see: this does not make the target's "Show my stats" toggle
-- (user_streaks.stats_visible) or leaderboard_opt_in govern whose mastery a
-- signed-in user may read. After this migration any signed-in user can still
-- read any Pro user's mastery numbers by user_id, as today. Adding that gate
-- would silently zero out the mastery figure on profile/[userId].tsx for
-- non-opted-in pilots (the screen currently shows it unconditionally, unlike
-- ratings/coins/aircraft which it already hides behind realVisible). Degrades
-- gracefully rather than crashing -- `return;` yields no rows and
-- src/lib/study.ts:144 falls back to {0,0,0,0} -- but it is a visible product
-- change, so it is RC's call, not this file's.
-- ============================================================================

create or replace function public.get_study_mastery(
  p_item_type text default null::text,
  p_user_id uuid default null::uuid
)
returns table(mastered integer, seen integer, total_available integer, pct integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_key text := coalesce(p_item_type, '__all__');
  v_mastered int;
  v_seen int;
  v_total int;
  v_pct int;
  v_best int;
begin
  -- ADDED 2026-08-31: refuse unauthenticated callers. Without this, anon can
  -- pass any p_user_id and both READ that user's progress and WRITE their
  -- study_mastery_high_water row. Every real call site has a session.
  if auth.uid() is null then
    return;
  end if;

  if not public.has_pro_access(v_uid) then
    return;
  end if;

  select count(*) filter (where correct_streak >= 2), count(*)
    into v_mastered, v_seen
    from study_progress
    where user_id = v_uid and (p_item_type is null or item_type = p_item_type);

  select (
    case when p_item_type is null or p_item_type = 'pcg' then
      (select count(*) from pcg_terms where definition is not null and definition <> '') else 0 end
    + case when p_item_type is null or p_item_type = 'far' then
      (select count(*) from study_far_sections) else 0 end
    + case when p_item_type is null or p_item_type = 'aim' then
      (select count(*) from aim_paragraphs where body_text is not null and body_text <> '') else 0 end
    + case when p_item_type is null or p_item_type = 'ac' then
      (select count(*) from advisory_circulars where status = 'active' and description is not null and description <> '' and title is not null and title <> '') else 0 end
    + case when p_item_type is null or p_item_type = 'dictionary' then
      (select count(*) from dictionary_terms where category in ('handbook', 'mnemonic') and senses->0->>'definition' is not null and senses->0->>'definition' <> '') else 0 end
  ) into v_total;

  v_pct := case when v_total = 0 then 0 else round(v_mastered * 100.0 / v_total) end;

  insert into study_mastery_high_water (user_id, item_type, best_pct, best_mastered)
  values (v_uid, v_key, v_pct, v_mastered)
  on conflict (user_id, item_type) do update
    set best_pct = greatest(study_mastery_high_water.best_pct, excluded.best_pct),
        best_mastered = greatest(study_mastery_high_water.best_mastered, excluded.best_mastered),
        updated_at = now()
  returning best_pct into v_best;

  return query select v_mastered, v_seen, v_total, greatest(v_pct, v_best);
end;
$function$;

-- VERIFY AFTER APPLYING:
--  1. Unauthenticated, publishable key only -- must now return []:
--       curl -X POST "$URL/rest/v1/rpc/get_study_mastery" -H "apikey: $ANON" \
--            -H "Content-Type: application/json" \
--            -d '{"p_item_type":null,"p_user_id":"<any real uuid>"}'
--  2. Confirm no overload was created (must return exactly one row):
--       select oid::regprocedure from pg_proc p join pg_namespace n
--         on n.oid = p.pronamespace
--        where n.nspname='public' and p.proname='get_study_mastery';
--  3. In the app, signed in: Study screen and the Search tab identity card
--     still show the caller's own mastery ring, and the Community profile
--     page still shows another Pro pilot's mastery figure.
