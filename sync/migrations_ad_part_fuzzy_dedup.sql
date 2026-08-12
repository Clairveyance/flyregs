-- Fuzzy dedup for AD parts extraction (task: "smart enough to recognize
-- parts it may have never seen before... something to compare to").
--
-- Real risk found before shipping: naive trigram similarity is dangerous
-- for alphanumeric PART NUMBERS specifically, where a single-character
-- difference means a genuinely different real part. Calibrated against
-- real corpus pairs before picking any threshold:
--   'HC-C2Y Propeller' vs 'HC-C3Y Propeller' (different real Hartzell
--     part numbers)                                       -> sim 0.70
--   'Garmin GTN 650' vs 'Garmin GTN 750' (different real
--     avionics units)                                      -> sim 0.647
--   'PW120 turboprop engine' vs 'PW120 Turboprop Engine'
--     (same part, case only)                                -> sim 1.0
--   'Garmin GTN 650' vs 'Garmin GTN650' (same part, no space) -> sim 0.6875
-- A single fuzzy threshold can't safely separate "same part, different
-- wording" from "different part, similar wording" -- 0.70 alone would
-- already wrongly merge the HC-C2Y/HC-C3Y pair. So this returns TWO
-- distinct signals instead of one score:
--   1. exact_normalized -- name matches an existing active part once
--      punctuation/whitespace/case are stripped. Deterministic, zero risk
--      of conflating two different part numbers (even a 1-character
--      difference normalizes to a different string). Safe to auto-merge.
--   2. fuzzy_candidate -- real trigram similarity, for anything that isn't
--      a normalized-exact match. NEVER auto-merged -- the caller inserts
--      it as its own row with status='pending_review' (invisible to real
--      users via the existing ad_parts_read_active RLS policy, which
--      already only shows status='active' rows) instead, for a human to
--      actually decide.

create or replace function public.find_ad_part_match(p_name text, p_component_type text)
returns table(id uuid, name text, match_type text, similarity real)
language sql
stable
as $$
  with norm as (
    select regexp_replace(lower(p_name), '[^a-z0-9]', '', 'g') as n
  ),
  exact as (
    select p.id, p.name, 'exact_normalized'::text as match_type, 1.0::real as similarity
    from public.ad_parts p, norm
    where p.status = 'active'
      and p.component_type = p_component_type
      and regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') = norm.n
    limit 1
  ),
  fuzzy as (
    select p.id, p.name, 'fuzzy_candidate'::text as match_type, similarity(p.name, p_name) as similarity
    from public.ad_parts p
    where p.status = 'active'
      and p.component_type = p_component_type
      and p.name % p_name
    order by similarity(p.name, p_name) desc
    limit 1
  )
  select * from exact
  union all
  select * from fuzzy where not exists (select 1 from exact)
  limit 1;
$$;
