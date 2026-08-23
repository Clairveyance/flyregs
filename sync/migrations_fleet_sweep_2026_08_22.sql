-- My Aircraft / Fleet bug sweep, 2026-08-22. Two independent, confirmed-
-- live bugs, both verified against real disposable accounts before and
-- after this migration (scripts/fleet_sweep_regression_test.py).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Untagging a part left its AD matches behind forever.
--
-- my-aircraft/[id].tsx's remove-equipment confirm promises, verbatim:
--   "This untags the part from this aircraft -- AD alerts matched only by
--    this equipment will stop appearing."
-- Nothing ever made that true. backfill_aircraft_ad_notifications() writes
-- one user_ad_notifications row per (aircraft, AD) with matched_via =
-- 'equipment' for every AD that mentions a tagged part, and there is no
-- FK, trigger, or client call that removes those rows when the tag itself
-- is deleted (verified live: tag a part -> backfill -> 4 equipment rows;
-- delete the tag -> the same 4 rows are still there, still counted in
-- get_fleet_summary()'s open_ad_count and still listed on both screens).
-- So an owner who tags the wrong part -- or sells/replaces a component --
-- is stuck with its ADs permanently inflating their open count with no way
-- to clear them except dismissing each one by hand.
--
-- Prunes only what is genuinely orphaned: an equipment-matched row whose
-- AD is no longer mentioned by ANY part still tagged on this aircraft.
-- Deliberately left alone:
--   * matched_via = 'airframe' rows -- those come from make/model and have
--     nothing to do with equipment tags. (The airframe insert runs first in
--     backfill_aircraft_ad_notifications() and ON CONFLICT DO NOTHING keeps
--     it, so an AD matching BOTH is stored as 'airframe' and survives here.)
--   * complied_at rows -- a compliance mark is a maintenance RECORD the
--     owner entered, not an alert; silently deleting one on an untag would
--     be a worse bug than the one this fixes. It stops being an "AD alert"
--     the moment it's complied, which is exactly what the copy promises.
--   * dismissed_at rows -- kept for the same reason dismissAdNotification()
--     soft-deletes in the first place (see migrations_ad_dismiss.sql): the
--     UNIQUE(user_aircraft_id, ad_number) row is what stops a later
--     backfill from re-adding a false positive the user already removed.
--     Hard-deleting it here would quietly undo that.
--
-- Owner OR editor, matching editors_manage_shared_ad_notifications (an
-- editor can already untag equipment and mark ADs complied, so they must
-- be able to trigger the cleanup their own untag causes). Returns how many
-- rows were actually pruned so the caller can tell a no-op from real work.
CREATE OR REPLACE FUNCTION public.prune_orphaned_equipment_ad_notifications(p_user_aircraft_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_deleted integer;
begin
  if not exists (
    select 1 from user_aircraft where id = p_user_aircraft_id and user_id = auth.uid()
  ) and not public.has_aircraft_access(p_user_aircraft_id, true) then
    return 0;
  end if;

  delete from user_ad_notifications n
  where n.user_aircraft_id = p_user_aircraft_id
    and n.matched_via = 'equipment'
    and n.complied_at is null
    and n.dismissed_at is null
    and not exists (
      select 1
      from user_aircraft_equipment uae
      join ad_part_mentions apm on apm.part_id = uae.part_id
      where uae.user_aircraft_id = p_user_aircraft_id
        and apm.ad_number = n.ad_number
    );

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

REVOKE ALL ON FUNCTION public.prune_orphaned_equipment_ad_notifications(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.prune_orphaned_equipment_ad_notifications(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Rolling a recurring reminder forward permanently killed its push.
--
-- scripts/send-reminder-alerts.mjs sends ONCE per reminder and records that
-- in notified_at, deliberately (the schema has no snooze concept, so a
-- daily repeat would just be noise). But this app has no "mark complete"
-- action for a reminder -- the ONLY way to handle a recurring item (Annual,
-- ELT battery, transponder; the form literally labels the field "LENGTH
-- (RECURS EVERY)") is to edit the same row's due date forward to the next
-- cycle. updateAircraftReminder() never touched notified_at, so:
--   reminder fires once -> owner rolls it to next year -> notified_at is
--   still set -> that reminder never pushes again, for the life of the row.
-- Verified live: notified_at stayed stamped at the old date after a real
-- PATCH moving due_date 400 days out.
--
-- A trigger rather than a client-side field, on purpose: the client isn't
-- the only writer (an editor collaborator writes through the same table
-- from a different screen, and any future automation would too), and this
-- is a rule about the row, not about one form. Fires only on a genuine
-- due-date change, so editing a title/notes/interval on a reminder that
-- already pushed does NOT re-arm it and cause a duplicate.
CREATE OR REPLACE FUNCTION public.rearm_reminder_on_due_date_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.due_date is distinct from old.due_date then
    new.notified_at := null;
  end if;
  return new;
end;
$$;

DROP TRIGGER IF EXISTS trg_rearm_reminder_on_due_date_change ON user_aircraft_reminders;
CREATE TRIGGER trg_rearm_reminder_on_due_date_change
  BEFORE UPDATE ON user_aircraft_reminders
  FOR EACH ROW EXECUTE FUNCTION public.rearm_reminder_on_due_date_change();
