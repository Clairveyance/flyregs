-- Gating sweep 2026-08-11, batch 4.
--
-- Equipment tags (Premium) and Maintenance reminders (Pro -- live code/FAQ
-- corrected this from the matrix's stale "Premium," see commit 9ac97c1 and
-- src/app/faq.tsx:117-118,242,247; flagging the matrix itself needs
-- updating separately) -- both had a "collaborator" path already correctly
-- entitlement-aware via has_aircraft_access(), but the OWNER's own path
-- (*_own_rows) was pure ownership, no tier check at all. A Pro (not
-- Premium) user could tag equipment and get the real, ongoing value of
-- Premium's "more precise AD matching" for free, indefinitely -- this
-- isn't just an access leak, send-ad-alerts.mjs actually computes real
-- weekly matches against every such tag.
-- No has_premium_access() helper exists in this codebase -- every other
-- Premium check (finalize_challenge_if_done, has_folder_access, etc.)
-- reads user_entitlements.is_premium directly, matched here for
-- consistency rather than introducing a new wrapper for one call site.
DROP POLICY IF EXISTS user_aircraft_equipment_own_rows ON public.user_aircraft_equipment;
CREATE POLICY user_aircraft_equipment_own_rows ON public.user_aircraft_equipment
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_equipment.user_aircraft_id AND ua.user_id = auth.uid()) AND EXISTS (SELECT 1 FROM user_entitlements ue WHERE ue.user_id = auth.uid() AND ue.is_premium = true))
  WITH CHECK (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_equipment.user_aircraft_id AND ua.user_id = auth.uid()) AND EXISTS (SELECT 1 FROM user_entitlements ue WHERE ue.user_id = auth.uid() AND ue.is_premium = true));

DROP POLICY IF EXISTS user_aircraft_reminders_own_rows ON public.user_aircraft_reminders;
CREATE POLICY user_aircraft_reminders_own_rows ON public.user_aircraft_reminders
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_reminders.user_aircraft_id AND ua.user_id = auth.uid()) AND has_pro_access(auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM user_aircraft ua WHERE ua.id = user_aircraft_reminders.user_aircraft_id AND ua.user_id = auth.uid()) AND has_pro_access(auth.uid()));

-- AD Parts/Component search bar (Plus) -- ad_parts/ad_part_mentions had no
-- tier check at all; parts-lookup.tsx's own whole-screen client lock was
-- the only gate. A user's own pending-suggestion visibility (suggested_by
-- = auth.uid()) is left ungated on purpose -- seeing your own submission
-- regardless of tier isn't consuming paid content, it's your own data.
DROP POLICY IF EXISTS ad_parts_read_active ON public.ad_parts;
CREATE POLICY ad_parts_read_active ON public.ad_parts
  FOR SELECT
  USING ((status = 'active' AND has_plus_access()) OR suggested_by = auth.uid());

DROP POLICY IF EXISTS ad_part_mentions_read_all ON public.ad_part_mentions;
CREATE POLICY ad_part_mentions_read_all ON public.ad_part_mentions
  FOR SELECT
  USING (has_plus_access());
