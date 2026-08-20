-- Daily refresh of search_popularity from real click data, via pg_cron   2026-08-20
--
-- RC: "our system should be smart enough to know that, and to also stay
-- flexible if/as search patterns create diff priorities." A one-time
-- snapshot wouldn't satisfy that -- this needs to keep adapting.
--
-- refresh_search_popularity() recomputes every rankable table's
-- search_popularity column from search_click_log, using a ROLLING 90-day
-- window -- it resets to 0 first, then re-derives from recent clicks only.
-- That's deliberate: a doc that was popular two months ago but isn't
-- anymore should fade back out of the ranking bonus, not permanently keep
-- whatever score it once earned. This is what makes the signal genuinely
-- adaptive rather than a second static list.
--
-- Scheduled via pg_cron rather than a Claude scheduled task (the pattern
-- used elsewhere in this project for recurring jobs) on purpose: this is
-- pure SQL aggregation with zero judgment calls -- routing it through an
-- agent session would spend real AI cost every single day forever for a
-- job that needs none, directly against the project's own standing "No
-- Ongoing AI COGS" rule. pg_net was already installed; pg_cron was not.
create extension if not exists pg_cron;

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
end;
$function$;

-- Not granted to anon/authenticated -- this is internal maintenance, never
-- called from the client. pg_cron's job runs as the database owner.
select cron.schedule('refresh_search_popularity', '17 8 * * *', $$select public.refresh_search_popularity();$$);
