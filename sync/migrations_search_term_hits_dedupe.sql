-- search_term_hits: stop recomputing to_tsvector(text) once per query term   2026-08-20
--
-- RC: "if there's opportunity for improvement in any area, then do it."
-- Continued past the search_norm_title fix (same file set, same date) to
-- find the NEXT dominant cost in search_far: EXPLAIN ANALYZE showed the
-- Sort step alone (where out_rank is computed) taking ~185ms on top of a
-- ~45ms join -- and search_term_hits(title, query) is called once per
-- matched row (1,723 times for a typical query).
--
-- Root cause: the original implementation looped over each lexeme in the
-- QUERY and, for every single one, recomputed to_tsvector('english', p_text)
-- from scratch to test membership:
--   select count(*) from unnest(tsvector_to_array(to_tsvector(p_query))) t
--   where to_tsvector(p_text) @@ to_tsquery(quote_literal(t.term))
-- For an N-word query this tokenizes p_text N separate times per row, when
-- it only ever needs to happen once. Rewritten to tokenize p_text exactly
-- once and test lexeme membership by array containment -- same semantics
-- (does each query lexeme appear as a lexeme in the text), same result for
-- every case that matters here (plain lexemes, no prefix/weight matching
-- was ever used by any caller), just without the redundant re-tokenization.
-- Used by search_far/search_aim/search_cfr49/search_acs/
-- search_legal_interpretations -- fixing the shared helper once benefits
-- all five without touching any of them.
create or replace function public.search_term_hits(p_text text, p_query text)
returns integer
language sql
immutable
as $function$
  select count(*)::int
  from unnest(tsvector_to_array(to_tsvector('english', coalesce(p_query, '')))) as q(term)
  where q.term = any(tsvector_to_array(to_tsvector('english', coalesce(p_text, ''))));
$function$;
