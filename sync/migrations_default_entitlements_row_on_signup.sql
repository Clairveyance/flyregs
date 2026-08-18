-- RC's "more full gating checks" audit pass, 2026-08-18. Real, live,
-- currently-exploitable gap found via a genuinely fresh disposable account
-- (not the ?tier= web stub, not a downgrade scenario -- a brand-new signup
-- that has simply never had a user_entitlements row written for it).
--
-- fleet_visible_cap() and folder_visible_cap() both deliberately treat "no
-- user_entitlements row for this user" as UNCAPPED (2147483647), on purpose
-- -- see their own comments: "a sync hiccup must never make a paying
-- customer's fleet/folders look deleted... the client's own RevenueCat
-- check covers that window." That reasoning only holds if the missing-row
-- state is truly transient AND the client is the only path that ever
-- exercises the gate. Neither held:
--
-- 1. Nothing ever creates a user_entitlements row for a brand-new signup.
--    src/lib/revenuecat.ts's syncEntitlements() is the only thing that
--    writes one (via the sync-entitlements edge function), and it is only
--    called from src/context/auth.tsx's cold-start
--    supabase.auth.getSession().then(...) branch -- explicitly NOT from the
--    onAuthStateChange handler that fires for a real sign-up/sign-in
--    (comment: "Once per real session-init only... not on every
--    onAuthStateChange firing below"). A user who signs up, confirms, and
--    starts using the app in that same session -- without ever force-
--    quitting and cold-starting with an existing session -- can go
--    indefinitely with zero entitlements row.
-- 2. The gate is reachable directly via REST with nothing but a valid JWT
--    (confirmed live: a disposable @flyregs.invalid account, freshly
--    created, zero entitlements row, inserted 5 unlimited aircraft in a row
--    via a raw POST to /rest/v1/user_aircraft -- no client, no UI, no
--    RevenueCat SDK involved at all). "The client's own check covers that
--    window" is not a server-side guarantee -- this is exactly the
--    client-only-gate anti-pattern (gotcha_tier_gate_client_side_only.md)
--    applied to a different function, just reached via a missing row
--    instead of a stale cache.
--
-- Fix: guarantee the row exists from the moment the auth.users row does,
-- so "missing row" stops being a reachable state for any user created from
-- here on -- closing the loophole at its root rather than chasing every
-- client call site that could theoretically race it. This preserves the
-- original fail-open intent for the case it actually meant to cover (some
-- future genuine data anomaly on an existing account) without leaving it
-- exploitable by simply never syncing. Mirrors trigger_send_welcome_email's
-- own on_auth_user_* trigger shape (SECURITY DEFINER, search_path pinned).
CREATE OR REPLACE FUNCTION public.create_default_entitlements()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.user_entitlements (user_id, is_pro, is_premium, is_unlocked, updated_at)
  VALUES (NEW.id, false, false, false, now())
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_created_entitlements ON auth.users;
CREATE TRIGGER on_auth_user_created_entitlements
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.create_default_entitlements();

-- Backfill: 2 real rows currently missing this at time of writing, both
-- confirmed disposable QA accounts (previewpane-*@flyregs.com,
-- qafree-*@flyregs.invalid), not real customers -- but backfilling
-- unconditionally is correct regardless, and closes the gap for those two
-- specific JWTs immediately rather than leaving them exploitable until
-- deleted.
INSERT INTO public.user_entitlements (user_id, is_pro, is_premium, is_unlocked, updated_at)
SELECT u.id, false, false, false, now()
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.user_entitlements e WHERE e.user_id = u.id);
