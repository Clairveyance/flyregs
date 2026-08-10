-- Fix: get_word_of_the_day() has been permission-denied for EVERY caller,
-- every tier, since it was written -- not a tier-gating bug, a genuine
-- broken feature. Found as a side effect of the 2026-08-10 Dictionary
-- re-gate work (chasing an unrelated 401 in the browser console).
--
-- Root cause: dictionary_terms.senses has no SELECT grant for anon or
-- authenticated at all (confirmed via information_schema.column_privileges)
-- -- every OTHER column on the table does, deliberately, so reading real
-- definition text is only possible through dictionary_terms_gated (a view,
-- which -- like a SECURITY DEFINER function -- runs with its owner's table
-- privileges, not the querying role's) or through a SECURITY DEFINER
-- function like search_dictionary(). get_word_of_the_day() was written as
-- a plain function (LANGUAGE sql STABLE, no SECURITY DEFINER) that reads
-- dictionary_terms.senses directly -- so it always executed with the
-- CALLING role's own privileges, which never had SELECT on that column,
-- and has been throwing "permission denied for table dictionary_terms" on
-- every single call since it was created. The client's own
-- getWordOfTheDay() has a bare .catch(() => {}), so this failed completely
-- silently -- DailyWordCard's `if (!wordOfDay) return null` meant the
-- entire feature was just invisible, not visibly broken, for every tier
-- including paying Premium accounts.
--
-- Verified live before this fix: anon -> HTTP 401, a real Premium account
-- -> HTTP 403, both "permission denied for table dictionary_terms".
--
-- Fix: SECURITY DEFINER (matching search_dictionary's already-correct
-- pattern), logic otherwise byte-identical.

CREATE OR REPLACE FUNCTION public.get_word_of_the_day(for_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(slug text, term text, definition text, source text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with pool as (
    select slug, term, (senses->0->>'definition') as definition, source
    from dictionary_terms
    where senses->0->>'definition' is not null
      and length(senses->0->>'definition') >= 40
      and (senses->0->>'definition') not ilike 'see %'
  ),
  ordered as (
    select *, row_number() over (order by slug) - 1 as idx, count(*) over () as total
    from pool
  )
  select slug, term, case when public.has_plus_access() then definition else null end as definition, source
  from ordered
  where idx = (abs(hashtext('word-' || for_date::text)) % total);
$function$;
