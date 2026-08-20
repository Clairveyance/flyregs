-- ============================================================================
-- Mastery leaderboard: apply the same high-water-mark ratchet as the
-- profile screen's Overall Mastery                                2026-08-19
-- ============================================================================
--
-- Found during today's tier-gating re-audit sweep: get_study_mastery() was
-- given a ratchet (study_mastery_high_water) so a user's own displayed % can
-- never dip when the live corpus grows, but get_mastery_leaderboard() was
-- never updated to match -- it still computes a raw, un-ratcheted pct, so
-- the SAME user could see a higher % on their own profile than on the
-- Ready Room leaderboard. Not a security/tier issue, a display-consistency
-- one, but worth closing while it's fresh.
--
-- This also WRITES to the ratchet (not just reads it) -- a user who never
-- opens their own profile but appears on the leaderboard should still get
-- their personal-best % recorded, so whichever screen "sees" a given pct
-- first doesn't matter.

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
    with raw as (
      select
        u.id as uid,
        coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Member')::text as label,
        count(sp.*) filter (where sp.correct_streak >= 2)::int as mastered_ct,
        count(sp.*)::int as seen_ct,
        case when v_total = 0 then 0
          else round(count(sp.*) filter (where sp.correct_streak >= 2) * 100.0 / v_total)::int
        end as raw_pct,
        u.raw_user_meta_data->>'avatar_url' as av_url,
        u.raw_user_meta_data->>'avatar_preset' as av_preset
      from user_streaks us
      join auth.users u on u.id = us.user_id
      left join study_progress sp on sp.user_id = us.user_id
      left join callsign_registry cr on cr.user_id = us.user_id
      where us.leaderboard_opt_in = true
        and public.has_pro_access(us.user_id)
      group by u.id, u.raw_user_meta_data, u.email, cr.callsign
      having count(sp.*) filter (where sp.correct_streak >= 2) > 0
    ),
    ratcheted as (
      insert into study_mastery_high_water (user_id, item_type, best_pct, best_mastered)
      select uid, '__all__', raw_pct, mastered_ct from raw
      on conflict (user_id, item_type) do update
        set best_pct = greatest(study_mastery_high_water.best_pct, excluded.best_pct),
            best_mastered = greatest(study_mastery_high_water.best_mastered, excluded.best_mastered),
            updated_at = now()
      returning study_mastery_high_water.user_id as uid, study_mastery_high_water.best_pct as best_pct
    )
    select
      raw.uid,
      raw.label,
      raw.mastered_ct,
      raw.seen_ct,
      v_total,
      greatest(raw.raw_pct, ratcheted.best_pct),
      raw.uid = auth.uid(),
      raw.av_url,
      raw.av_preset
    from raw
    join ratcheted on ratcheted.uid = raw.uid
    order by greatest(raw.raw_pct, ratcheted.best_pct) desc, raw.mastered_ct desc
    limit p_limit;
end;
$function$;
