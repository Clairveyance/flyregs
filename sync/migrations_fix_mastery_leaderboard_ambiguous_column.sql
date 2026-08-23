-- Fixes a real, live production bug found by a fresh Sentry sweep,
-- 2026-08-22: get_mastery_leaderboard() has been throwing a plpgsql
-- "column reference 'user_id' is ambiguous" (42702) error for every Pro
-- user on Ready Room's Mastery tab since at least build 34 -- confirmed
-- live via the exact Sentry breadcrumb (POST .../rpc/get_mastery_
-- leaderboard -> HTTP 400, "It could refer to either a PL/pgSQL variable
-- or a table column"). Root cause: this function's RETURNS TABLE declares
-- `user_id uuid` as an OUT parameter, and the function body's
-- `insert into study_mastery_high_water (...) on conflict (user_id,
-- item_type) do update ...` needs `user_id` to mean the TABLE's column,
-- not the OUT parameter -- a well-known plpgsql collision class,
-- specifically around ON CONFLICT target lists.
--
-- Fix: `#variable_conflict use_column`, the standard Postgres pragma for
-- exactly this -- tells plpgsql to prefer the table-column interpretation
-- whenever a bare identifier collides with a declared variable/OUT
-- parameter, for the rest of this function body. Verified safe here: none
-- of this function's other OUT parameter names (display_label, mastered,
-- seen, total_available, pct, is_me, avatar_url, avatar_preset) appear as
-- bare identifiers anywhere the query means something else by them -- the
-- CTEs deliberately alias every column to a different name (uid, label,
-- mastered_ct, seen_ct, raw_pct, av_url, av_preset) specifically to avoid
-- this, and the only actual collision is the one this fixes.
CREATE OR REPLACE FUNCTION public.get_mastery_leaderboard(p_limit integer DEFAULT 50)
 RETURNS TABLE(user_id uuid, display_label text, mastered integer, seen integer, total_available integer, pct integer, is_me boolean, avatar_url text, avatar_preset text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
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
