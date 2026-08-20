-- Search usage logging: what people search, and what they open because of it   2026-08-20
--
-- RC: "our system should log all search topics and prioritize results based
-- on that, as well as on the actual subject matter being requested... stay
-- flexible if/as search patterns create diff priorities."
--
-- Two separate, deliberately simple tables, not one:
--   search_query_log  -- every real search fired (raw demand: "what are
--                         people typing"). Useful on its own, independent
--                         of ranking -- RC can eventually just read this.
--   search_click_log   -- which document a search actually led to opening
--                         (the real signal: "what did this query end up
--                         being FOR"). This is what feeds the ranking
--                         signal below -- a query alone doesn't tell you
--                         which of N results was the right one, but a
--                         click does.
-- Anonymous by design (no user_id) -- this is aggregate usage-pattern data
-- for ranking, not a personalization feature RC asked for, and keeping it
-- anonymous is simpler and more private. INSERT-only RLS: any client can
-- log its own search/click event, nobody can read anyone else's (locked to
-- service_role / the Management API used for aggregation).
create table if not exists search_query_log (
  id bigint generated always as identity primary key,
  query_text text not null,
  created_at timestamptz not null default now()
);
alter table search_query_log enable row level security;
create policy "anyone can log a search" on search_query_log for insert to anon, authenticated with check (true);
-- RLS policy alone is not sufficient -- PostgREST/Postgres also requires
-- the base table-level GRANT before RLS is even evaluated. Missing this
-- was caught live: a real anon-key INSERT returned 401 "permission denied
-- for table search_query_log" until this was added.
grant insert on public.search_query_log to anon, authenticated;
create index if not exists idx_search_query_log_created on search_query_log(created_at);

create table if not exists search_click_log (
  id bigint generated always as identity primary key,
  doc_type text not null,
  doc_id text not null,
  query_text text,
  created_at timestamptz not null default now()
);
alter table search_click_log enable row level security;
create policy "anyone can log a search click" on search_click_log for insert to anon, authenticated with check (true);
grant insert on public.search_click_log to anon, authenticated;
create index if not exists idx_search_click_log_created on search_click_log(created_at);
create index if not exists idx_search_click_log_doc on search_click_log(doc_type, doc_id);

-- ── pcg_terms never got citation_count in this morning's citation-authority
-- migration either (that pass only covered advisory_circulars/far_sections/
-- aim_paragraphs/cfr49_sections) -- P/CG is squarely "the regs corpus" too
-- (6,208 real incoming citations in document_citations, second only to
-- far_part), so it gets the same treatment here rather than staying an
-- unexplained exception.
alter table pcg_terms add column if not exists citation_count integer not null default 0;
update pcg_terms p set citation_count = c.n
from (select cited_id, count(*) as n from document_citations where cited_type = 'pcg' group by cited_id) c
where c.cited_id = p.slug;

-- ── search_popularity: same precomputed-column pattern as citation_count
-- (never a live aggregate join -- search is already the thing that was just
-- fixed for being too slow). Added to every rankable corpus table, even
-- though it starts at 0 everywhere -- there is no historical click data to
-- backfill, and fabricating any would defeat the entire point of this
-- being a REAL usage signal. It goes from inert to meaningful purely by
-- accumulating real taps over time -- see refresh_search_popularity() in
-- the companion migration for how it's kept current.
alter table advisory_circulars add column if not exists search_popularity integer not null default 0;
alter table far_sections add column if not exists search_popularity integer not null default 0;
alter table aim_paragraphs add column if not exists search_popularity integer not null default 0;
alter table cfr49_sections add column if not exists search_popularity integer not null default 0;
alter table pcg_terms add column if not exists search_popularity integer not null default 0;
-- airworthiness_directives / legal_interpretations already got this column
-- in migrations_search_ad_loi_parity.sql (same date) -- not repeated here.

-- ── wire search_popularity into search_far/search_aim/search_cfr49/search_pcg
-- (search_acs and search_ads/search_legal_interpretations already carry it
-- from today's earlier migrations). Same log-scaled, modest weight as
-- citation_count (*5) -- this is meant to nudge among close competitors,
-- not overpower actual subject-matter relevance, which stays the dominant
-- signal (anchors, title match, ts_rank).
create or replace function public.search_far(query text, result_limit integer default 20)
returns table(section_number text, part text, subpart_title text, title text, out_rank real, is_anchor boolean)
language sql
stable
as $function$
  with rq as (
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  lex as (
    select distinct (m)[1] as clean
    from rq, regexp_matches(to_tsvector('english', rq.resolved)::text, $$'([^']+)'$$, 'g') as m
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      (select to_tsquery('english', string_agg(clean || ':*', ' | ')) from lex) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'far'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  )
  select f.section_number, f.part, f.subpart_title, f.title,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when search_norm_title(f.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(f.title) like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(search_norm_title(f.title)) >= 6
                  and length(search_norm_title(f.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(f.title))
             then 260 else 0 end
      + (search_term_hits(f.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when f.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(f.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(f.search_vector, q.or_q) * 20
      + ln(1 + f.citation_count) * 5
      + ln(1 + f.search_popularity) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from far_sections f
  cross join q
  left join anchors an on an.doc_id = f.section_number
  where f.search_vector @@ q.or_q or an.doc_id is not null
  order by out_rank desc, f.section_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

create or replace function public.search_aim(query text, result_limit integer default 20)
returns table(paragraph_number text, chapter text, section_title text, title text, out_rank real, is_anchor boolean)
language sql
stable
as $function$
  with rq as (
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  lex as (
    select distinct (m)[1] as clean
    from rq, regexp_matches(to_tsvector('english', rq.resolved)::text, $$'([^']+)'$$, 'g') as m
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      (select to_tsquery('english', string_agg(clean || ':*', ' | ')) from lex) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'aim'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  )
  select a.paragraph_number, a.chapter, a.section_title, a.title,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when search_norm_title(a.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(a.title) like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(search_norm_title(a.title)) >= 6
                  and length(search_norm_title(a.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(a.title))
             then 260 else 0 end
      + (search_term_hits(a.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when a.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(a.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(a.search_vector, q.or_q) * 20
      + ln(1 + a.citation_count) * 5
      + ln(1 + a.search_popularity) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from aim_paragraphs a
  cross join q
  left join anchors an on an.doc_id = a.paragraph_number
  where a.search_vector @@ q.or_q or an.doc_id is not null
  order by out_rank desc, a.paragraph_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

create or replace function public.search_cfr49(query text, result_limit integer default 20)
returns table(section_number text, part text, family text, subpart_title text, title text, out_rank real, is_anchor boolean)
language sql
stable
as $function$
  with rq as (
    select coalesce(nullif(search_resolve_query(query), ''), query) as resolved
  ),
  lex as (
    select distinct (m)[1] as clean
    from rq, regexp_matches(to_tsvector('english', rq.resolved)::text, $$'([^']+)'$$, 'g') as m
  ),
  q as (
    select
      plainto_tsquery('english', rq.resolved) as and_q,
      (select to_tsquery('english', string_agg(clean || ':*', ' | ')) from lex) as or_q,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase,
      btrim(regexp_replace(lower(rq.resolved), '\s+', ' ', 'g')) as rphrase,
      search_term_count(rq.resolved) as n_terms
    from rq
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'cfr49'
      and (search_anchor_matches(q.phrase, a.phrase)
           or search_anchor_matches(q.rphrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  )
  select f.section_number, f.part, p.family, f.subpart_title, f.title,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + case when search_norm_title(f.title) = q.phrase then 1000 else 0 end
      + case when search_norm_title(f.title) like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(search_norm_title(f.title)) >= 6
                  and length(search_norm_title(f.title))::numeric
                        / greatest(length(q.phrase), 1) >= 0.6
                  and search_phrase_contains(q.phrase, search_norm_title(f.title))
             then 260 else 0 end
      + (search_term_hits(f.title, q.rphrase)::numeric / q.n_terms) * 180
      + case when f.search_vector @@ q.and_q then 60 else 0 end
      + case when lower(coalesce(f.body_text, '')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(f.search_vector, q.or_q) * 20
      + ln(1 + f.citation_count) * 5
      + ln(1 + f.search_popularity) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from cfr49_sections f
  join cfr49_parts p on p.part = f.part
  cross join q
  left join anchors an on an.doc_id = f.section_number
  where f.search_vector @@ q.or_q or an.doc_id is not null
  order by out_rank desc, f.section_number
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

create or replace function public.search_pcg(query text, result_limit integer default 20)
returns table(slug text, term text, definition text, out_rank real, is_anchor boolean)
language sql
stable
as $function$
  with q as (
    select
      plainto_tsquery('english', query) as tsq,
      btrim(regexp_replace(lower(query), '\s+', ' ', 'g')) as phrase
  ),
  lexemes as (
    select (m)[1] as clean
    from regexp_matches(to_tsvector('english', query)::text, $$'([^']+)'$$, 'g') as m
  ),
  filtered as (
    select distinct clean from lexemes where length(clean) >= 3
  ),
  wq as (
    select
      to_tsquery('english', string_agg(clean || ':*', ' & ')) as and_q,
      to_tsquery('english', string_agg(clean || ':*', ' | ')) as or_q,
      count(*) as n_lex
    from filtered
  ),
  anchors as (
    select a.doc_id, max(case when a.phrase = q.phrase then length(a.phrase) + 10000 else length(a.phrase) end) as best_len
    from search_concept_anchors a, q
    where a.doc_type = 'pcg'
      and (search_anchor_matches(q.phrase, a.phrase)
           or (length(q.phrase) >= 3 and search_phrase_contains(a.phrase, q.phrase)))
    group by a.doc_id
  ),
  lexical as (
    select p.slug, p.term, p.definition, p.search_vector, ts_rank(p.search_vector, q.tsq) as base_rank
    from pcg_terms p, q
    where p.search_vector @@ q.tsq
  ),
  -- Only fires when the strict AND tier found NOTHING at all (query-wide,
  -- matching search_dictionary's semantics exactly) -- this is a rescue
  -- path for otherwise-empty results, not a general loosening of every
  -- search. The n_lex<=2-or-half-match guard keeps long, wordy questions
  -- from matching on a single incidental shared word.
  fallback as (
    select p.slug, p.term, p.definition, p.search_vector, ts_rank(p.search_vector, wq.or_q) as base_rank
    from pcg_terms p, wq
    where wq.or_q is not null
      and p.search_vector @@ wq.or_q
      and not exists (select 1 from lexical)
      and (
        wq.n_lex <= 2
        or (
          select count(*) from filtered f
          where p.search_vector @@ to_tsquery('english', f.clean || ':*')
        ) >= ceil(wq.n_lex / 2.0)
      )
  ),
  anchor_only as (
    select p.slug, p.term, p.definition, p.search_vector, 0::real as base_rank
    from pcg_terms p
    join anchors an on an.doc_id = p.slug
    where not exists (select 1 from lexical l where l.slug = p.slug)
      and not exists (select 1 from fallback fb where fb.slug = p.slug)
  ),
  combined as (
    select * from lexical
    union all select * from fallback
    union all select * from anchor_only
  )
  select c.slug, c.term, c.definition,
    (
      coalesce(2000 + an.best_len * 10, 0)
      + ((length(lower(coalesce(c.definition,''))) - length(replace(lower(coalesce(c.definition,'')), q.phrase, ''))) / greatest(length(q.phrase), 1)) * 1000
      + c.base_rank
      + ln(1 + coalesce(pt.citation_count, 0)) * 5
      + ln(1 + coalesce(pt.search_popularity, 0)) * 5
    )::real as out_rank,
    (an.doc_id is not null) as is_anchor
  from combined c
  cross join q
  left join anchors an on an.doc_id = c.slug
  left join pcg_terms pt on pt.slug = c.slug
  order by out_rank desc
  limit (case when public.has_plus_access() then result_limit else least(result_limit, 10) end);
$function$;

grant execute on function public.search_far(text, integer) to anon, authenticated;
grant execute on function public.search_aim(text, integer) to anon, authenticated;
grant execute on function public.search_cfr49(text, integer) to anon, authenticated;
grant execute on function public.search_pcg(text, integer) to anon, authenticated;
