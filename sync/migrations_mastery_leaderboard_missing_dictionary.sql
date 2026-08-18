-- Found during the regression sweep on
-- migrations_study_mastery_missing_dictionary.sql (get_study_mastery() +
-- record_study_review()): a third function computes the exact same
-- "total available" corpus sum and was missed by that fix.
-- get_mastery_leaderboard() (Ready Room's Mastery leaderboard tab) still
-- summed only pcg_terms + study_far_sections + aim_paragraphs +
-- advisory_circulars into v_total -- dictionary_terms was never added here
-- either, even though get_study_mastery()'s own header comment says the
-- goal was "'available' means the same pool in all three functions."
-- There are actually four call sites of this sum; this one was left behind.
--
-- Live-verified before this fix: for a real user (37008a21-...) with 64
-- mastered / 71 seen, get_study_mastery() (already fixed today) reported
-- total_available=12143 while get_mastery_leaderboard() reported 5757 for
-- the SAME user's SAME underlying mastered/seen counts -- a real, visible
-- inconsistency between the Ready Room leaderboard and the user's own
-- Study screen, and the leaderboard pct was computed off the smaller,
-- wrong denominator (inflated exactly like the original bug).
--
-- Fix: add dictionary_terms to v_total here too, using the identical
-- eligibility filter the other three functions already use (category in
-- handbook/mnemonic, first sense has a real definition). Body otherwise
-- copied verbatim from pg_get_functiondef of the live function -- no other
-- change.

create or replace function public.get_mastery_leaderboard(p_limit integer default 50)
 returns table(user_id uuid, display_label text, mastered integer, seen integer, total_available integer, pct integer, is_me boolean, avatar_url text, avatar_preset text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_total integer;
begin
  if not public.has_pro_access() then
    return;
  end if;

  select (
    (select count(*) from pcg_terms where definition is not null and definition <> '')
    + (select count(*) from study_far_sections)
    + (select count(*) from aim_paragraphs where body_text is not null and body_text <> '')
    + (select count(*) from advisory_circulars where status = 'active' and description is not null and description <> '' and title is not null and title <> '')
    + (select count(*) from dictionary_terms where category in ('handbook', 'mnemonic') and senses->0->>'definition' is not null and senses->0->>'definition' <> '')
  ) into v_total;

  return query
    select
      u.id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Member')::text,
      count(sp.*) filter (where sp.correct_streak >= 2)::int as mastered,
      count(sp.*)::int as seen,
      v_total as total_available,
      case when v_total = 0 then 0
        else round(count(sp.*) filter (where sp.correct_streak >= 2) * 100.0 / v_total)::int
      end as pct,
      u.id = auth.uid(),
      u.raw_user_meta_data->>'avatar_url',
      u.raw_user_meta_data->>'avatar_preset'
    from user_streaks us
    join auth.users u on u.id = us.user_id
    left join study_progress sp on sp.user_id = us.user_id
    left join callsign_registry cr on cr.user_id = us.user_id
    where us.leaderboard_opt_in = true
      and public.has_pro_access(us.user_id)
    group by u.id, u.raw_user_meta_data, u.email, cr.callsign
    having count(sp.*) filter (where sp.correct_streak >= 2) > 0
    order by pct desc, mastered desc
    limit p_limit;
end;
$function$;
