-- RC, 2026-08-16: "the opponent avatar - isn't that the point of selecting
-- 'show me' in settings? ... if a user has the ability to select it on/off,
-- i don't understand why it's a big deal."
--
-- Correct call, confirmed against how these RPCs already behave: opting
-- into leaderboard_opt_in ("Show Me") is ALREADY the one-way visibility
-- gate that puts your Callsign in front of every Pro/Premium user on the
-- Ready Room leaderboards and in every Premium user's Duels opponent list
-- (get_challengeable_users, get_ready_room_leaderboard, get_duels_leaderboard,
-- get_mastery_leaderboard all filter on `leaderboard_opt_in = true` with no
-- reciprocal opt-in required from the viewer). Avatar visibility had never
-- been aligned to that same rule -- it was still gated behind
-- get_profile_avatar's folder/aircraft-collaborator check, a DIFFERENT,
-- narrower relationship (RC, 2026-08-08, when that check was built: "images
-- or other personal content will be anonymized to people you don't collab
-- with"). That 2026-08-08 stance was about strangers with no relationship at
-- all; it was never meant to also block someone who explicitly opted their
-- Callsign onto a public leaderboard from also being recognizable by photo
-- in that exact same context.
--
-- This migration does two things:
-- 1. Widens get_profile_avatar's connected-check with the same
--    leaderboard_opt_in OR-branch, so tapping into someone's profile from
--    the leaderboard/Duels also shows their real photo/preset once opted in.
-- 2. Adds avatar_url/avatar_preset directly to the four leaderboard/
--    opponent RPCs so list rows (Duels opponent picker, all three Ready
--    Room leaderboard tabs) can render a real avatar circle without an
--    extra per-row round trip -- these RPCs already SECURITY DEFINER-filter
--    to opted-in rows only, so no new exposure beyond what's already public
--    on the leaderboard.

create or replace function public.get_profile_avatar(p_user_id uuid)
returns table(out_avatar_url text, out_avatar_preset text, out_connected boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_connected boolean;
  v_avatar_url text;
  v_avatar_preset text;
begin
  if p_user_id = auth.uid() then
    v_connected := true;
  else
    select
      exists (
        select 1 from folder_collaborators fc
        where fc.left_at is null and (
          (fc.owner_id = auth.uid() and fc.user_id = p_user_id) or
          (fc.user_id = auth.uid() and fc.owner_id = p_user_id)
        )
      )
      or exists (
        select 1 from aircraft_collaborators ac
        where ac.left_at is null and ac.accepted_at is not null and (
          (ac.owner_id = auth.uid() and ac.user_id = p_user_id) or
          (ac.user_id = auth.uid() and ac.owner_id = p_user_id)
        )
      )
      -- Opting into Show Me already puts your Callsign in front of any
      -- Pro/Premium user via the leaderboard RPCs below -- your avatar
      -- follows the same one-way rule, no reciprocal opt-in required.
      or exists (
        select 1 from user_streaks us
        where us.user_id = p_user_id and us.leaderboard_opt_in = true
      )
    into v_connected;
  end if;

  if v_connected then
    select (u.raw_user_meta_data->>'avatar_url'), (u.raw_user_meta_data->>'avatar_preset')
      into v_avatar_url, v_avatar_preset
      from auth.users u where u.id = p_user_id;
  end if;

  return query select v_avatar_url, v_avatar_preset, coalesce(v_connected, false);
end;
$function$;

-- Adding output columns changes the function's row type, which Postgres
-- won't let CREATE OR REPLACE do in place -- has to drop first.
drop function if exists public.get_ready_room_leaderboard(integer);
drop function if exists public.get_duels_leaderboard(integer);
drop function if exists public.get_mastery_leaderboard(integer);
drop function if exists public.get_challengeable_users();

create or replace function public.get_ready_room_leaderboard(p_limit integer default 20)
returns table(user_id uuid, display_label text, weekly_reviews bigint, weekly_correct bigint, current_streak integer, is_me boolean, avatar_url text, avatar_preset text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.has_pro_access() then
    return;
  end if;
  return query
    select
      u.id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Member')::text,
      count(sp.*) filter (where sp.last_reviewed_at >= now() - interval '7 days')::bigint as weekly_reviews,
      count(sp.*) filter (where sp.last_reviewed_at >= now() - interval '7 days' and sp.total_correct > 0)::bigint as weekly_correct,
      coalesce(us.current_streak, 0),
      u.id = auth.uid(),
      u.raw_user_meta_data->>'avatar_url',
      u.raw_user_meta_data->>'avatar_preset'
    from user_streaks us
    join auth.users u on u.id = us.user_id
    left join study_progress sp on sp.user_id = us.user_id
    left join callsign_registry cr on cr.user_id = us.user_id
    where us.leaderboard_opt_in = true
      and public.has_pro_access(us.user_id)
    group by u.id, u.raw_user_meta_data, u.email, us.current_streak, cr.callsign
    having count(sp.*) filter (where sp.last_reviewed_at >= now() - interval '7 days') > 0
    order by weekly_reviews desc
    limit p_limit;
end;
$function$;

create or replace function public.get_duels_leaderboard(p_limit integer default 50)
returns table(user_id uuid, display_label text, wins integer, losses integer, ties integer, is_me boolean, avatar_url text, avatar_preset text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.has_pro_access() then
    return;
  end if;
  return query
    select
      u.id,
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', 'Member')::text,
      coalesce(s.wins, 0),
      coalesce(s.losses, 0),
      coalesce(s.ties, 0),
      u.id = auth.uid(),
      u.raw_user_meta_data->>'avatar_url',
      u.raw_user_meta_data->>'avatar_preset'
    from user_streaks us
    join auth.users u on u.id = us.user_id
    left join user_duel_stats s on s.user_id = us.user_id
    left join callsign_registry cr on cr.user_id = us.user_id
    where us.leaderboard_opt_in = true
      and public.has_pro_access(us.user_id)
      and coalesce(s.wins, 0) + coalesce(s.losses, 0) + coalesce(s.ties, 0) > 0
    order by coalesce(s.wins, 0) desc, coalesce(s.losses, 0) asc
    limit p_limit;
end;
$function$;

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

create or replace function public.get_challengeable_users()
returns table(user_id uuid, display_label text, avatar_url text, avatar_preset text)
language plpgsql
security definer
as $function$
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Duels requires Premium';
  end if;

  return query
  select
    u.id,
    coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))::text,
    u.raw_user_meta_data->>'avatar_url',
    u.raw_user_meta_data->>'avatar_preset'
  from user_streaks us
  join auth.users u on u.id = us.user_id
  left join callsign_registry cr on cr.user_id = u.id
  where us.leaderboard_opt_in = true
    and u.id != auth.uid()
    and exists (select 1 from user_entitlements ue2 where ue2.user_id = u.id and ue2.is_premium = true)
  order by display_label;
end;
$function$;
