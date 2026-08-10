-- Re-gate the Aviation Dictionary per RC's 2026-08-10 decision: "Plus gets
-- the A/D, not the Mnemonics. Pro also gets Mnemonics." This reverses the
-- 2026-08-03 call (base A/D free, only Mnemonics+DailyWord at Plus) --
-- resolving what flyregs_decisions.md's own Aviation Dictionary entries
-- left as genuinely open ("if we did make it free...").
--
-- New tier shape: base A/D (10,081 terms) -> Plus. Mnemonics specifically
-- (category='mnemonic') -> Pro (a stricter tier nested inside the Plus
-- gate, same shape as My Fleet's cap sitting inside the broader Pro tier).
-- Word of the Day is unchanged (already Plus, already consistent with the
-- new base tier).
--
-- Found and fixed in the SAME pass: search_dictionary() read straight from
-- the raw dictionary_terms table with ZERO tier check on `definition` --
-- unlike dictionary_terms_gated, it was never wired into the original
-- Plus/Mnemonic gating at all. Federates into Home's own SmartSearch
-- (unifiedSearch.ts) too, so this was a real leak surface even before
-- today's re-gate, just a smaller one (nothing was gated to leak past). Not
-- fixing this alongside the view would have left the exact "screen is
-- locked, but search results still show the real definition text" gap this
-- session already found and fixed for other features.

CREATE OR REPLACE VIEW public.dictionary_terms_gated AS
SELECT id, term, slug, letter, category,
  CASE
    WHEN category = 'mnemonic' THEN (CASE WHEN public.has_pro_access() THEN senses ELSE NULL END)
    ELSE (CASE WHEN public.has_plus_access() THEN senses ELSE NULL END)
  END AS senses,
  source, pcg_term_id, external_refs, updated_at, mnemonic_group, see_also_slug
FROM public.dictionary_terms;

CREATE OR REPLACE FUNCTION public.search_dictionary(query text, result_limit integer DEFAULT 20)
 RETURNS TABLE(slug text, term text, definition text, out_rank real)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with lexemes as (
    select (m)[1] as clean
    from regexp_matches(to_tsvector('english', query)::text, $$'([^']+)'$$, 'g') as m
  ),
  filtered as (
    select distinct clean from lexemes where length(clean) >= 3
  ),
  pq as (
    select
      to_tsquery('english', string_agg(clean || ':*', ' & ')) as and_q,
      to_tsquery('english', string_agg(clean || ':*', ' | ')) as or_q,
      count(*) as n_lex
    from filtered
  ),
  hits as (
    select d.slug, d.term,
      case when d.category = 'mnemonic'
        then (case when public.has_pro_access() then (d.senses->0->>'definition') else null end)
        else (case when public.has_plus_access() then (d.senses->0->>'definition') else null end)
      end as definition,
      ts_rank(d.search_vector, pq.and_q) as out_rank
    from dictionary_terms d, pq
    where pq.and_q is not null and d.search_vector @@ pq.and_q
  ),
  fallback as (
    select d.slug, d.term,
      case when d.category = 'mnemonic'
        then (case when public.has_pro_access() then (d.senses->0->>'definition') else null end)
        else (case when public.has_plus_access() then (d.senses->0->>'definition') else null end)
      end as definition,
      ts_rank(d.search_vector, pq.or_q) as out_rank
    from dictionary_terms d, pq
    where pq.or_q is not null
      and d.search_vector @@ pq.or_q
      and not exists (select 1 from hits)
      and (
        pq.n_lex <= 2
        or (
          select count(*) from filtered f
          where d.search_vector @@ to_tsquery('english', f.clean || ':*')
        ) >= ceil(pq.n_lex / 2.0)
      )
  )
  select x.slug, x.term, x.definition, x.out_rank
  from (select * from hits union all select * from fallback) x
  order by
    (length(lower(x.term)) - length(replace(lower(x.term), lower(query), ''))) / greatest(length(query), 1) desc,
    x.out_rank desc
  limit result_limit;
$function$;
