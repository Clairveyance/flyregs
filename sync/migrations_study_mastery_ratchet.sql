-- ============================================================================
-- Overall Mastery: never show a lower % than the user has already seen
--                                                                  2026-08-19
-- ============================================================================
--
-- RC: "in Profile, my Overall Mastery was at 1%, but then it dropped to 0%.
-- That shouldn't happen. OM is acquired gradually and only builds to 100%,
-- it doesn't regress."
--
-- Investigated against RC's own real study_progress rows first, not
-- guessed: `mastered` (count of items with correct_streak >= 2) never
-- actually went backwards -- 6 items mastered, zero rows found where
-- total_correct >= 2 but correct_streak had since dropped below 2 (which
-- would indicate a genuine "missed a previously-mastered item" reset).
-- The real cause is `pct`'s DENOMINATOR: total_available is a live count of
-- the current corpus (pcg_terms + study_far_sections + aim_paragraphs +
-- advisory_circulars + dictionary_terms), recomputed fresh on every call.
-- This session's own dictionary-mnemonic authoring work grew that count
-- into the thousands, so `mastered / total_available` mathematically
-- shrank even though `mastered` itself never moved down -- 6 items over a
-- smaller corpus rounded to 1%, the same 6 items over today's larger
-- corpus round to 0%.
--
-- Fix: store each user's personal-best % ever seen (per item_type, or
-- '__all__' for the unfiltered Overall Mastery call) and always display
-- the higher of "today's honest ratio" and "the best this user has ever
-- been shown" -- a ratchet, not a fabricated number. The underlying
-- mastered/total_available are still returned honestly; only `pct` is
-- floored at the high-water mark.

create table if not exists public.study_mastery_high_water (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null default '__all__',
  best_pct integer not null default 0,
  best_mastered integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_type)
);

alter table public.study_mastery_high_water enable row level security;
-- No client policies at all -- this table is only ever touched by
-- get_study_mastery itself (SECURITY DEFINER); never read or written
-- directly by the client.

create or replace function public.get_study_mastery(p_item_type text default null, p_user_id uuid default null)
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
