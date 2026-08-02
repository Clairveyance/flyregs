-- getFarPartOptions() derived the FAR Part filter list from
-- `.select('part')` over far_sections -- 4,272 rows, silently truncated to
-- 1,000 by PostgREST (the same cap that has bitten this codebase twice
-- before; see memory/gotcha_postgrest_1000_row_cap). The dropdown showed
-- ~45 of the real 82 parts, and "Select all" therefore matched 3,954 of
-- 4,272 sections: 318 sections lived in parts that never appeared as
-- options at all. Distinct values belong in SQL, not in a truncated fetch.
create or replace function public.get_far_parts()
returns table(part text, section_count int)
language sql
stable
as $function$
  select part, count(*)::int
  from far_sections
  where part is not null
  group by part
  order by nullif(regexp_replace(part, '[^0-9].*$', ''), '')::numeric nulls last, part;
$function$;

grant execute on function public.get_far_parts() to anon, authenticated;
