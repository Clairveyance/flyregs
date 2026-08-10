-- Fix: acs_tasks/acs_elements (RefPack task Objective/Knowledge/Risk-Management/
-- Skills/References content) had a "public read" RLS policy (USING (true)) and
-- no client-side gate at all on the task detail screen
-- (src/app/ref-packets/task/[taskId].tsx) -- fully readable by a completely
-- anonymous caller despite RefPacks being a documented Plus-tier feature
-- (ref-packets/[code].tsx, the parent list screen, IS correctly gated both
-- client- and (via this same RLS gap) not server-side).
--
-- Found+live-proven via the 2026-08-10 full-app tier-gate audit (curl with no
-- JWT at all returned full task objectives and element body text).
--
-- Unlike AD/LOI/AC/Dictionary (which need partial, per-column redaction via a
-- _gated view, since those screens show some metadata to every tier), the
-- RefPack task screen's own client design is already all-or-nothing -- it
-- never queries acs_tasks/acs_elements at all unless hasPlusAccess is already
-- true (see the paired client-side fix to task/[taskId].tsx, same commit).
-- So the simplest, most robust fix is row-level: tighten the RLS policy
-- itself with has_plus_access() instead of true. This requires zero client
-- code changes (the existing .from('acs_tasks')/.from('acs_elements') calls
-- automatically get zero rows for a non-Plus caller) and closes the direct-
-- API-bypass hole the curl proof demonstrated.
--
-- acs_documents (top-level RefPack names) and acs_areas_of_operation (area
-- labels) are deliberately left open -- comparable sensitivity to how AC/LOI
-- titles stay discoverable in free search while body text is gated; only the
-- actual curated content (task objectives, element body text) is the real
-- paid substance here.

DROP POLICY IF EXISTS "acs_tasks public read" ON public.acs_tasks;
CREATE POLICY "acs_tasks public read" ON public.acs_tasks
  FOR SELECT
  USING (public.has_plus_access());

DROP POLICY IF EXISTS "acs_elements public read" ON public.acs_elements;
CREATE POLICY "acs_elements public read" ON public.acs_elements
  FOR SELECT
  USING (public.has_plus_access());
