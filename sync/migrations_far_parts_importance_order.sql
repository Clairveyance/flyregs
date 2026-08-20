-- Reorder FAR Parts by real-world importance, not part number    2026-08-20
--
-- RC: "bump priorities to the universally most searched Parts, to make
-- sure that the things that MOST users will be looking for show up
-- quickly, in ready view, and are fast to open." RC did their own outside
-- research on which FAR parts get searched most and shared a ranked list
-- (91, 61, 107, 43, 67, 121, 135, 141, 39, 1, 117, 119, 23, 25, 21, 65,
-- 145, 147, 142 -- 830 is 49 CFR NTSB reporting, handled separately below,
-- already correctly #1 in cfr49_parts).
--
-- Two independent things drove FAR Part order before this, confirmed by
-- direct investigation, not assumed:
--   1. far_parts.sort_order -- currently plain numeric-ascending (Part 1,
--      3, 5, 11, 13...) -- drives far/index.tsx's own browse list.
--   2. get_far_parts() RPC -- its OWN hardcoded ORDER BY, numeric-ascending
--      too, COMPLETELY INDEPENDENT of far_parts.sort_order -- drives
--      Home's Filter-sheet FAR Part chips. Reordering only #1 would have
--      silently left #2 unfixed (a real regression trap, caught before
--      writing this migration, not after).
--
-- Fix: single source of truth. far_parts.sort_order now encodes RC's
-- researched top-19 order first (positions 0-18, exact order given), then
-- every remaining FAR Part ordered by average incoming citations per
-- section (using the citation_count column added earlier this same session
-- for the search-ranking work -- reused here rather than inventing a
-- second signal) as an objective, non-guessed tail ordering for the ~64
-- parts outside RC's researched list. Deliberately AVERAGE per section,
-- not raw SUM -- Part 25 (Transport Category Airplanes, 406 sections) has
-- the single highest raw citation SUM in the whole corpus purely from
-- internal engineering cross-referencing density (the same cluster-density
-- effect already documented in migrations_search_citation_authority_
-- ranking.sql's own comment) -- confirmed RC's own researched list does
-- NOT rank Part 25 especially high, so a raw-sum tail signal would have
-- fought RC's own judgment instead of complementing it; per-section
-- average avoids that bias. get_far_parts() now joins far_parts and orders
-- by its sort_order directly, instead of duplicating separate logic that
-- could drift out of sync again.
update far_parts set sort_order = case part
  when '91' then 0
  when '61' then 1
  when '107' then 2
  when '43' then 3
  when '67' then 4
  when '121' then 5
  when '135' then 6
  when '141' then 7
  when '39' then 8
  when '1' then 9
  when '117' then 10
  when '119' then 11
  when '23' then 12
  when '25' then 13
  when '21' then 14
  when '65' then 15
  when '145' then 16
  when '147' then 17
  when '142' then 18
  when '110' then 19
  when '33' then 20
  when '45' then 21
  when '139' then 22
  when '5' then 23
  when '26' then 24
  when '129' then 25
  when '97' then 26
  when '133' then 27
  when '111' then 28
  when '38' then 29
  when '35' then 30
  when '34' then 31
  when '120' then 32
  when '47' then 33
  when '89' then 34
  when '137' then 35
  when '68' then 36
  when '36' then 37
  when '194' then 38
  when '103' then 39
  when '29' then 40
  when '136' then 41
  when '27' then 42
  when '158' then 43
  when '125' then 44
  when '60' then 45
  when '3' then 46
  when '161' then 47
  when '105' then 48
  when '48' then 49
  when '171' then 50
  when '155' then 51
  when '157' then 52
  when '99' then 53
  when '193' then 54
  when '151' then 55
  when '16' then 56
  when '71' then 57
  when '77' then 58
  when '101' then 59
  when '183' then 60
  when '49' then 61
  when '63' then 62
  when '13' then 63
  when '17' then 64
  when '93' then 65
  when '15' then 66
  when '170' then 67
  when '11' then 68
  when '73' then 69
  when '198' then 70
  when '150' then 71
  when '185' then 72
  when '31' then 73
  when '152' then 74
  when '22' then 75
  when '187' then 76
  when '14' then 77
  when '189' then 78
  when '153' then 79
  when '95' then 80
  when '169' then 81
  when '156' then 82
  else 999
end;


create or replace function public.get_far_parts()
returns table(part text, section_count int)
language sql
stable
as $function$
  select s.part, count(*)::int
  from far_sections s
  where s.part is not null
  group by s.part
  order by coalesce((select fp.sort_order from far_parts fp where fp.part = s.part), 999);
$function$;

grant execute on function public.get_far_parts() to anon, authenticated;
