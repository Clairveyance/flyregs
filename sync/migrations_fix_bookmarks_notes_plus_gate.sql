-- Fix: synced_bookmarks and synced_notes had zero server-side Plus check --
-- ownership-only RLS (users_manage_own_synced_bookmarks/_notes, `auth.uid()
-- = user_id`), same shape as the aircraft/folder cap gaps fixed earlier in
-- this batch. Bookmarks and Notes are both explicitly Plus-tier features
-- (PROJECT_NOTES/flyregs_decisions.md's Plus feature list), gated client-
-- side (ac/[id].tsx's handleToggleHighlight, notes.tsx's create path) but
-- not server-side.
--
-- Live-proven, not just grant-level inference: a disposable Free-tier
-- account (zero user_entitlements row) successfully inserted both a real
-- synced_bookmarks row and a real synced_notes row directly via REST with
-- its own JWT, no client involved.
--
-- Ceiling is genuinely low (matches the earlier lower-confidence flag) --
-- the underlying AC/FAR/AIM/etc. content a bypassed bookmark/note could
-- reference is already server-redacted for non-Plus tiers regardless, so a
-- bypass only defeats the organizational-feature purchase itself, never
-- exposes gated content. Fixed anyway for gating consistency, matching this
-- session's other tier-integrity fixes.
--
-- BEFORE INSERT trigger (not an RLS policy change) so it scopes to CREATION
-- only -- a user who made Plus purchases, created bookmarks/notes, and later
-- somehow lost entitlement (shouldn't normally happen for a one-time
-- purchase, but matches the same defensive shape as the aircraft/folder cap
-- triggers) can still read/edit/delete their own existing rows; they just
-- can't create new ones without Plus access.

CREATE OR REPLACE FUNCTION public.enforce_bookmark_plus_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_plus_access(NEW.user_id) THEN
    RAISE EXCEPTION 'Bookmarks require Plus';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_bookmark_plus_gate ON public.synced_bookmarks;
CREATE TRIGGER trg_enforce_bookmark_plus_gate
  BEFORE INSERT ON public.synced_bookmarks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bookmark_plus_gate();

CREATE OR REPLACE FUNCTION public.enforce_note_plus_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_plus_access(NEW.user_id) THEN
    RAISE EXCEPTION 'Notes require Plus';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_note_plus_gate ON public.synced_notes;
CREATE TRIGGER trg_enforce_note_plus_gate
  BEFORE INSERT ON public.synced_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_note_plus_gate();
