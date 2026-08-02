create extension if not exists fuzzystrmatch;

-- ============================================================================
-- SmartSearch: typo + prefix tolerance, and looser anchor matching
--                                                            2026-07-31
--
-- Breadth suite misses this closes:
--   "oxy"     (partial word) -- not found at all
--   "oxigen"  (typo)         -- not found at all
--   "what instruments do I need for VFR" -- § 91.205 at #21
--
-- to_tsquery has no notion of "close to a real word": a misspelling simply
-- matches nothing, and a truncated word only matches if it happens to be a
-- real stem. search_vocabulary already holds every term in the corpus with
-- its document frequency, so it can be used as a SPELLING DICTIONARY:
-- resolve the user's word to the nearest real corpus word first, then search
-- for that. pg_trgm is already installed.
-- ============================================================================

-- Resolve one user word to the best real corpus word.
--   1. exact hit  -> itself
--   2. prefix hit -> most common word starting with it ("oxy" -> "oxygen")
--   3. fuzzy hit  -> most similar word above a threshold ("oxigen" -> "oxygen")
-- Returns NULL when nothing is close enough, so callers can leave the word
-- alone rather than substituting nonsense.
create or replace function public.search_resolve_term(p_word text)
returns text
language sql
stable
as $function$
  with w as (select lower(btrim(p_word)) as t)
  select coalesce(
    (select v.term from search_vocabulary v, w where v.term = w.t limit 1),
    -- Prefix: only for inputs long enough to be meant as a prefix, and
    -- ranked by corpus frequency so "oxy" lands on "oxygen", not
    -- "oxygen-fed".
    (select v.term from search_vocabulary v, w
      where length(w.t) >= 3 and v.term like w.t || '%'
      order by v.doc_freq desc, length(v.term) limit 1),
    -- Fuzzy, for genuine misspellings only.
    --
    -- Trigram similarity ALONE is not safe here: it rewrote "drunk" to
    -- "drug" (a different real word, similarity 0.4), which broke the
    -- everyday-vocabulary path entirely -- "flying drunk" fell to #33.
    -- Edit distance alone doesn't separate them either: drunk->drug and
    -- manuever->maneuver are both distance 2.
    --
    -- What DOES separate them is length. A short word has too few letters
    -- for a 2-edit change to still mean the same thing, while a long word
    -- with 1-2 edits is almost certainly a typo. Measured:
    --   drunk(5)->drug(4)              lev 2  <- must NOT fire
    --   mins(4)->min(3)                lev 1  <- must NOT fire
    --   oxigen(6)->oxygen(6)           lev 1  <- must fire
    --   manuever(8)->maneuver(8)       lev 2  <- must fire
    --   altimiter(9)->altimeter(9)     lev 1  <- must fire
    --   requirments(11)->requirements  lev 1  <- must fire
    -- So: 6+ characters, edit distance <= 2, and a similar length. Anything
    -- shorter is left exactly as typed, and the bridge layer handles it as
    -- everyday vocabulary.
    (select v.term from search_vocabulary v, w
      where length(w.t) >= 6
        and abs(length(v.term) - length(w.t)) <= 2
        and levenshtein(v.term, w.t) <= 2
      order by levenshtein(v.term, w.t), v.doc_freq desc limit 1)
  );
$function$;

-- Rewrite a whole query into corpus vocabulary, word by word. Words that
-- resolve to nothing are kept as typed.
create or replace function public.search_resolve_query(p_query text)
returns text
language sql
stable
as $function$
  select btrim(string_agg(coalesce(search_resolve_term(w), w), ' ' order by ord))
  from unnest(string_to_array(lower(btrim(regexp_replace(coalesce(p_query,''), '\s+', ' ', 'g'))), ' '))
       with ordinality as u(w, ord);
$function$;

-- Anchor matching, looser: fire when every CONTENT WORD of the anchor phrase
-- appears somewhere in the query, not only when the phrase appears intact.
-- "what instruments do I need for VFR" contains both words of the anchor
-- "vfr instruments" but never as a contiguous phrase, so the strict rule
-- missed it and § 91.205 sat at #21.
create or replace function public.search_anchor_matches(p_query text, p_phrase text)
returns boolean
language sql
immutable
as $function$
  select
    -- contiguous, whole-word (the strict rule, still the strongest)
    search_phrase_contains(p_query, p_phrase)
    -- or: every word of the anchor is present in the query somewhere
    or (
      select bool_and(search_phrase_contains(p_query, w))
      from unnest(string_to_array(p_phrase, ' ')) as t(w)
      where length(w) >= 3
    );
$function$;
