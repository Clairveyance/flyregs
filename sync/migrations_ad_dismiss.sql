-- ============================================================================
-- AD dismiss (per-aircraft false-positive removal)  --  2026-08-01
--
-- RC, live, pointing at a G1000 AD matched via tagged equipment on his own
-- N21643 that doesn't actually apply to that airframe: "need to be able to
-- remove/delete an AD if you find it not relevant." The match rule (see
-- migrations_ad_backfill.sql) is deliberately broad -- RC also said he'd
-- rather over-match than risk silently excluding a real applicable AD --
-- so an occasional false positive is an accepted tradeoff, not a bug to
-- chase. This is the user's own escape hatch for that tradeoff.
--
-- Soft delete, not a row delete: user_ad_notifications has a UNIQUE
-- (user_aircraft_id, ad_number) constraint, and both sync paths
-- (backfill_aircraft_ad_notifications RPC and send-ad-alerts.mjs) write
-- with ON CONFLICT DO NOTHING / ignoreDuplicates. Leaving the row in place
-- with dismissed_at set is what makes that conflict landing on the
-- ALREADY-DISMISSED row rather than a fresh insert -- a hard delete would
-- just let the next backfill or weekly sync silently re-add the exact AD
-- the user removed.
-- ============================================================================

alter table public.user_ad_notifications add column if not exists dismissed_at timestamptz;

comment on column public.user_ad_notifications.dismissed_at is
  'Set when the user removes a false-positive AD match from their aircraft folder. Row is kept (not deleted) so the UNIQUE(user_aircraft_id, ad_number) constraint blocks backfill/sync from re-adding it.';
