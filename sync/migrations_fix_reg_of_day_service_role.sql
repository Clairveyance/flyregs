-- Fixes a real regression introduced by the 2026-08-11 gating sweep
-- (migrations_gating_sweep_batch1.sql): that pass correctly closed a real
-- leak (an anonymous/free-tier client calling get_reg_of_the_day() directly
-- got real Premium content back, gated only client-side) by adding
-- `and public.has_pro_access()` to the function's own WHERE clause.
--
-- But get_reg_of_the_day() has TWO callers, not one:
--   1. src/lib/notifications.ts (client, in-app "Reg of the Day" card) --
--      auth.uid() is a real signed-in user here, has_pro_access() is the
--      right check, unchanged by this fix.
--   2. scripts/send-reg-of-day.mjs (server, the daily push-notification
--      cron via GitHub Actions "Daily Reg of the Day" workflow) -- runs
--      with the SERVICE ROLE key, no user session at all, so auth.uid()
--      is null and has_pro_access() unconditionally returns false. This
--      call site ALREADY does its own correct per-recipient Pro/Premium
--      gating downstream (cross-references push_tokens against
--      user_entitlements via canReceiveProPush() before ever sending) --
--      the content itself is identical for every user on a given day, so
--      gating the single shared row a second time at the SQL level was
--      always redundant for this caller, and broke it outright: confirmed
--      live, the workflow failed every day starting 2026-08-12 ("Send Reg
--      of the Day" step erroring with "get_reg_of_the_day returned no row"
--      -- that error message is itself stale/wrong, guessing at pcg_terms
--      being empty, when the function doesn't even query pcg_terms).
--
-- auth.uid() can't tell "service role, no session" apart from "anonymous
-- public client, no session" -- both are null. auth.role() can: confirmed
-- live via a temporary probe function that a genuine service-key PostgREST
-- call resolves auth.role() to 'service_role' (not null), while auth.uid()
-- stays null. Gating on role instead of (or in addition to) has_pro_access()
-- lets the service-role caller through without reopening the anonymous-
-- client leak the original fix was for.
CREATE OR REPLACE FUNCTION public.get_reg_of_the_day(for_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(slug text, term text, definition text, source_type text)
 LANGUAGE sql
 STABLE
AS $function$
  with pool as (
    select item_id as slug, question as term, answer as definition, item_type as source_type
    from study_facts
    where item_type in ('far', 'aim')
      and status = 'live'
      and question is not null and question <> ''
      and answer is not null and answer <> ''
    union all
    select document_number as slug, title as term,
           (description || ' · ' || document_number) as definition,
           'ac' as source_type
    from advisory_circulars
    where status = 'active'
      and title is not null and title <> ''
      and description is not null and description <> ''
  ),
  ordered as (
    select *, row_number() over (order by source_type, slug) - 1 as idx, count(*) over () as total
    from pool
  )
  select slug, term, definition, source_type from ordered
  where idx = (abs(hashtext(for_date::text)) % total)
    and (auth.role() = 'service_role' or public.has_pro_access());
$function$;
