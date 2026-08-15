-- Two real, confirmed, immediately-fixable findings from a dedicated
-- gating-audit agent, 2026-08-14. (Two other findings from the same
-- audit -- document_citations/content_revisions still granting
-- `authenticated` raw-table SELECT as a deliberate build-31-compatibility
-- stopgap -- are NOT touched here: revoking that grant now would break
-- the still-live, still-latest-shipped build 31 for real current users,
-- since that build's code queries the raw tables directly. That's a
-- ship-a-new-build-first decision for RC, not something to fix blind.
-- Flagged separately in PROJECT_NOTES/flyregs_pending.md.)

-- Fix 1: user_aircraft_own_update still used the pre-fix blunt aggregate
-- cap check (has_visible_fleet_access(): a bare count(*) <= cap
-- comparison) instead of the per-row is_aircraft_visible() function
-- already built and applied to every OTHER visible-cap policy earlier
-- this same session (migrations_fix_visible_cap_per_row.sql) -- this one
-- policy was simply missed in that pass. Confirmed live by the audit
-- agent: a Pro user (cap=1) who owns 2 aircraft got HTTP 403 editing
-- their oldest (rank-1, correctly IN-cap) aircraft's own nickname --
-- exactly the "blocks writes to ALL of them, not just the locked one"
-- bug RC originally flagged, recurring on the one table it wasn't fixed
-- on yet. Same swap as folders_own_update got.
DROP POLICY IF EXISTS user_aircraft_own_update ON public.user_aircraft;
CREATE POLICY user_aircraft_own_update ON public.user_aircraft
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND public.is_aircraft_visible(id));

-- Fix 2: the Pro gate on bookmarks/notes (enforce_bookmark_plus_gate,
-- enforce_note_plus_gate) only ran BEFORE INSERT, never BEFORE UPDATE.
-- Confirmed live: a Pro test user created a bookmark, downgraded to
-- Free, then successfully PATCHed both its title AND its
-- document_number (fully repurposing which citation it points to) --
-- HTTP 200, no gate fired. A genuinely NEW insert while Free was
-- correctly blocked; only the update path was open. A downgraded user
-- kept full indefinite edit/repurpose rights on anything created while
-- they had Pro. Same trigger function works unchanged for UPDATE (NEW.
-- user_id is available on both) -- this only adds the missing trigger
-- registration, no function body changes.
CREATE TRIGGER trg_enforce_bookmark_plus_gate_update
  BEFORE UPDATE ON public.synced_bookmarks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bookmark_plus_gate();

CREATE TRIGGER trg_enforce_note_plus_gate_update
  BEFORE UPDATE ON public.synced_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_note_plus_gate();
