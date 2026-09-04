CREATE OR REPLACE FUNCTION public.search_anchor_matches(p_query text, p_phrase text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select
    -- contiguous, whole-word (the strict rule, still the strongest)
    search_phrase_contains(p_query, p_phrase)
    -- or: every MEANINGFUL word of the anchor is present in the query
    -- somewhere. Used to drop any word under 3 characters from this check
    -- entirely -- meant to skip filler ("a", "i", "to", "of"...), but it
    -- also silently dropped real single-letter aviation vocabulary: the
    -- anchors 'class d'/'class b'/'class c'/'class e'/'class g' (built,
    -- deliberately, to fix Class D being buried behind Class B/A -- see
    -- doc_id 91.129's own anchor note) each degraded to "the query merely
    -- contains the word 'class'" once their own letter got dropped from the
    -- requirement. Confirmed live 2026-09-03, RC's own bug report: "class G
    -- airspace" matched the 'class d'/'class b'/'class c'/'class a' anchors
    -- too (none of them require "G" -- or, after this drop, their own
    -- letter either), so Class D/B/C/A operating rules all outranked the
    -- genuinely correct Class G section, which has no anchor of its own at
    -- all and loses on raw ts_rank (a longer, differently-phrased title).
    -- Same root defect as contentTerms' client-side length filter, fixed
    -- the same day for the same reason -- see relevanceTier's own comment.
    --
    -- Excluding true filler (this project's exact stopword set, restricted
    -- to the words actually short enough to be affected) instead of a bare
    -- length cutoff keeps existing recall for anchors like 'before a
    -- flight' or 'how low can i fly', where the dropped word genuinely is
    -- an article/pronoun, not a designator -- while requiring 'wx', 'mode
    -- c', and the class letters, where the short word IS the whole point
    -- of the phrase. NOTE: 'a'/'i' stay droppable (matching STOPWORDS)
    -- because they are true fillers in most of the other 48 affected
    -- anchors; 'class a' specifically keeps its narrower pre-existing
    -- behavior as a result (matches on 'class' alone, same as before) --
    -- a smaller, real, but never-reported edge case, not chased further
    -- here to avoid a broader regression across every OTHER anchor that
    -- legitimately needs 'a'/'i' droppable.
    or (
      select bool_and(
        search_phrase_contains(p_query, w)
        or w = any(array['a','an','or','of','to','in','on','at','by','is','be','do','i','my','me','if','it','am'])
      )
      from unnest(string_to_array(p_phrase, ' ')) as t(w)
    );
$function$
