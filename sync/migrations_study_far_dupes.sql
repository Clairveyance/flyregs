-- ============================================================================
-- Study pool: exclude FAR boilerplate whose title duplicates WITHIN its part
--                                                            2026-07-31
-- (rationale unchanged — see prior header block in git history)
--
-- MATERIALIZED, not a plain view: the within-part uniqueness needs a window
-- over all 4,272 sections, and as a plain view the planner re-derived it
-- inside get_study_queue's already-heavy CTE chain — measured straight into
-- a 57014 statement timeout. The membership set only changes when
-- far_sections changes (weekly), so it's precomputed and refreshed from
-- sync_far.sh via refresh_study_far_sections().
-- ============================================================================

drop view if exists public.study_far_sections;
drop materialized view if exists public.study_far_sections;

create materialized view public.study_far_sections as
select f.section_number
from (
  select section_number, title,
    count(*) over (partition by part, regexp_replace(title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '')) as uses
  from far_sections
  where title is not null and title <> '' and body_text is not null and body_text <> ''
) f
where f.uses = 1 and f.title not ilike '%[reserved%';

create unique index if not exists study_far_sections_pk
  on public.study_far_sections (section_number);

grant select on public.study_far_sections to anon, authenticated;

-- Refresh hook for the weekly FAR sync. SECURITY DEFINER so the service-key
-- PostgREST call in sync_far.sh can run it; CONCURRENTLY so live queries
-- never block on the refresh.
create or replace function public.refresh_study_far_sections()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  refresh materialized view concurrently public.study_far_sections;
end;
$function$;

revoke all on function public.refresh_study_far_sections() from public, anon, authenticated;
grant execute on function public.refresh_study_far_sections() to service_role;
