-- Fixes a real, live, exploitable content leak found during the 2026-08-19/20
-- access-points gating sweep (Edge Functions / deep-links / push payloads --
-- a DIFFERENT sweep from the same-dated RLS/storage/SECURITY DEFINER-grants
-- sweep in flyregs_pending.md's other section from this same date).
--
-- get_word_of_the_day()'s pool is drawn from ALL of dictionary_terms with no
-- category filter -- 52 real category='mnemonic' rows are eligible today
-- (confirmed live), and its own redaction only ever checked has_plus_access(),
-- never has_pro_access() for a mnemonic row the way dictionary_terms_gated
-- (the view every Dictionary DETAIL screen reads through) correctly does:
--
--   dictionary_terms_gated: category='mnemonic' -> has_pro_access(), else -> has_plus_access()
--   get_word_of_the_day (before this fix): always has_plus_access(), full stop
--
-- Confirmed live via a 61-day scan (generate_series + cross join lateral)
-- that the deterministic date-hash rotation lands on a real mnemonic
-- ("5 Ps") on 2026-09-11 -- a concrete near-future date, not a theoretical
-- edge case. On that date, under the old code:
--   - send-word-of-day.mjs calls this RPC with the service-role key (needed
--     to read the real text at all -- see this function's own prior
--     comment), gets the REAL mnemonic definition back, then sends it to
--     EVERY canReceivePlusPush() recipient -- i.e. every Plus-tier
--     subscriber, not just Pro+. A Plus (non-Pro) DailyWord subscriber gets
--     the real Pro-gated mnemonic text pushed to their lock screen.
--   - The same RPC is called directly by the client (notifications.ts's
--     getWordOfTheDay(), rendered by DailyWordCard in dictionary/index.tsx)
--     for the in-app Home/Dictionary "word of the day" card -- a genuine
--     Plus-but-not-Pro user who expands that card on a mnemonic day sees
--     the same real text right there, even though tapping through to
--     /dictionary/<slug> correctly shows them the Pro paywall for that
--     exact term via dictionary_terms_gated. Both surfaces trusted the
--     wrong (too-low) bar for a subset of the pool.
--
-- Fix: mirror dictionary_terms_gated's exact redaction shape, and surface
-- `category` in the return row so callers (the push script specifically)
-- can apply the correct per-day recipient tier without a second query.
-- service_role keeps its full-content escape hatch (needed so the push
-- script can still read the real text to build the notification body before
-- doing its own recipient-side tier filtering) -- unchanged from the
-- original 2026-08-16 design intent, just extended to the mnemonic case.
--
-- RETURNS TABLE signature is changing (adding `category`), which
-- CREATE OR REPLACE cannot do in place -- DROP first, matching the standing
-- gotcha_create_or_replace_signature_overload.md lesson (a naive
-- CREATE OR REPLACE here would either error on incompatible return type or,
-- worse, silently create a second overload instead of replacing).
DROP FUNCTION IF EXISTS public.get_word_of_the_day(date);

CREATE FUNCTION public.get_word_of_the_day(for_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(slug text, term text, definition text, source text, category text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with pool as (
    select slug, term, (senses->0->>'definition') as definition, source, category,
           case when pcg_term_id is not null then 20 else 0 end as weight
    from dictionary_terms
    where senses->0->>'definition' is not null
      and length(senses->0->>'definition') >= 40
      and (senses->0->>'definition') not ilike 'see %'
  ),
  bucketed as (
    select *,
           sum(weight + 1) over (order by slug rows between unbounded preceding and current row) as bucket_hi,
           sum(weight + 1) over (order by slug rows between unbounded preceding and 1 preceding) as bucket_lo
    from pool
  ),
  totaled as (select sum(weight + 1) as total_weight from pool)
  select b.slug, b.term,
         case
           when auth.role() = 'service_role' then b.definition
           when b.category = 'mnemonic' then (case when public.has_pro_access() then b.definition else null end)
           else (case when public.has_plus_access() then b.definition else null end)
         end as definition,
         b.source, b.category
  from bucketed b, totaled t
  where (abs(hashtext('word-' || for_date::text)) % t.total_weight) >= coalesce(b.bucket_lo, 0)
    and (abs(hashtext('word-' || for_date::text)) % t.total_weight) < b.bucket_hi;
$function$;

GRANT EXECUTE ON FUNCTION public.get_word_of_the_day(date) TO anon, authenticated, service_role;
