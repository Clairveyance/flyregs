-- Replace the static FAR-Parts priority list with a live, self-adjusting score   2026-08-20
--
-- RC: "our system should be smart enough to know that, and to also stay
-- flexible if/as search patterns create diff priorities." This morning's
-- fix (migrations_far_parts_importance_order.sql) hardcoded RC's own
-- researched top-19 list plus a one-time citation-average tail -- a real
-- improvement over plain numeric order, but a SECOND static snapshot, not
-- the adaptive system RC is now explicitly asking for.
--
-- refresh_far_parts_priority() replaces that hardcoded CASE expression with
-- a live composite score, recomputed daily by the same pg_cron job that
-- refreshes search_popularity (this function runs right after it, in the
-- same call, so Part priority always reflects the just-updated numbers):
--
--   score = rc_prior_bonus(part)                         -- strong anchor
--         + ln(1 + avg citation_count per section) * 5    -- corpus structure
--         + ln(1 + avg search_popularity per section) * 8 -- real usage
--
-- rc_prior_bonus gives RC's researched top-19 a large head start (1900 for
-- Part 91 down to 100 for Part 142, in RC's exact given order) -- deliberately
-- large enough that it takes SUSTAINED, real, disproportionate usage
-- evidence to ever move a Part out of RC's top tier, not a few days of
-- noise. This is the honest middle ground RC is asking for: not a frozen
-- list (usage genuinely CAN reshape the order over time), and not
-- discarding real domain research on day one in favor of a cold-start
-- signal that starts at zero. AVERAGE per section, not raw SUM, for the
-- same reason as this morning's fix -- Part 25's 406-section engineering
-- cross-reference density would otherwise dominate purely from size.
create or replace function public.refresh_far_parts_priority()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  top19 text[] := array['91','61','107','43','67','121','135','141','39','1','117','119','23','25','21','65','145','147','142'];
begin
  with per_part as (
    select s.part, avg(s.citation_count) as avg_citation, avg(s.search_popularity) as avg_pop
    from far_sections s
    where s.part is not null
    group by s.part
  ),
  scored as (
    select
      p.part,
      coalesce((select (array_length(top19, 1) - (idx - 1)) * 100
                from unnest(top19) with ordinality as u(part, idx)
                where u.part = p.part), 0)
      + ln(1 + coalesce(pp.avg_citation, 0)) * 5
      + ln(1 + coalesce(pp.avg_pop, 0)) * 8
      as score
    from far_parts p
    left join per_part pp on pp.part = p.part
  ),
  ranked as (
    select part, row_number() over (order by score desc, part) - 1 as rnk
    from scored
  )
  update far_parts fp
  set sort_order = r.rnk
  from ranked r
  where r.part = fp.part;
end;
$function$;

-- Chain onto the existing daily refresh -- Part priority should always run
-- against freshly-updated search_popularity, and one cron job is simpler to
-- reason about than coordinating two independently-scheduled ones.
create or replace function public.refresh_search_popularity()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update advisory_circulars set search_popularity = 0 where search_popularity <> 0;
  update far_sections set search_popularity = 0 where search_popularity <> 0;
  update aim_paragraphs set search_popularity = 0 where search_popularity <> 0;
  update pcg_terms set search_popularity = 0 where search_popularity <> 0;
  update cfr49_sections set search_popularity = 0 where search_popularity <> 0;
  update airworthiness_directives set search_popularity = 0 where search_popularity <> 0;
  update legal_interpretations set search_popularity = 0 where search_popularity <> 0;

  update advisory_circulars a set search_popularity = c.n
  from (select doc_id, count(*) as n from search_click_log where doc_type = 'ac' and created_at > now() - interval '90 days' group by doc_id) c
  where c.doc_id = a.document_number;

  update far_sections f set search_popularity = c.n
  from (select doc_id, count(*) as n from search_click_log where doc_type = 'far' and created_at > now() - interval '90 days' group by doc_id) c
  where c.doc_id = f.section_number;

  update aim_paragraphs p set search_popularity = c.n
  from (select doc_id, count(*) as n from search_click_log where doc_type = 'aim' and created_at > now() - interval '90 days' group by doc_id) c
  where c.doc_id = p.paragraph_number;

  update pcg_terms t set search_popularity = c.n
  from (select doc_id, count(*) as n from search_click_log where doc_type = 'pcg' and created_at > now() - interval '90 days' group by doc_id) c
  where c.doc_id = t.slug;

  update cfr49_sections f set search_popularity = c.n
  from (select doc_id, count(*) as n from search_click_log where doc_type = 'cfr49' and created_at > now() - interval '90 days' group by doc_id) c
  where c.doc_id = f.section_number;

  update airworthiness_directives ad set search_popularity = c.n
  from (select doc_id, count(*) as n from search_click_log where doc_type = 'ad' and created_at > now() - interval '90 days' group by doc_id) c
  where c.doc_id = ad.ad_number;

  update legal_interpretations l set search_popularity = c.n
  from (select doc_id, count(*) as n from search_click_log where doc_type = 'loi' and created_at > now() - interval '90 days' group by doc_id) c
  where c.doc_id = l.slug;

  perform public.refresh_far_parts_priority();
end;
$function$;
