-- AD compliance records: one-time vs recurring.
-- APPLIED LIVE 2026-09-02. This file exists because the columns were created
-- directly against the database and had no migration -- exactly the drift the
-- project's own gotcha warns about (a schema that lives only in production is
-- a schema nobody can rebuild). Written retroactively, idempotent, so applying
-- it again is a no-op.
--
-- Robin (beta tester, 2026-09-02, submission 948cac3c-30c1-4e72-be19-524ad6ecc545):
-- "when the user taps 'mark complied', there should be a pop-up that asks
-- 'one time' or 'recurring'."

-- 'one_time' = complied once, done.
-- 'recurring' = complied, and due again; the next-due date/hours live on the
--               linked user_aircraft_reminders row (matched on linked_ad_number).
-- NULL = complied before this column existed; left alone deliberately so no
--        existing record silently changes meaning.
--
-- A real column rather than deriving "is it recurring" from whether a linked
-- reminder exists: deriving looks tidy but is fragile -- delete the reminder
-- and a recurring AD silently becomes a completed one, which is the wrong
-- direction for a compliance record.
alter table public.user_ad_notifications
  add column if not exists compliance_kind text
  check (compliance_kind in ('one_time','recurring'));

comment on column public.user_ad_notifications.compliance_kind is
  'one_time = complied once, done. recurring = complied, and due again; the '
  'next-due date/hours live on the linked row in user_aircraft_reminders '
  '(matched on linked_ad_number). NULL = complied before this column existed.';

-- Airframe hours at the moment the linked AD was complied. Paired with
-- due_hobbs_hours so "next due 2,150 hrs" reads against a real baseline
-- instead of floating, and reset each time the AD is complied again.
alter table public.user_aircraft_reminders
  add column if not exists complied_hobbs_hours numeric;

comment on column public.user_aircraft_reminders.complied_hobbs_hours is
  'Airframe hours at the moment the linked AD was last complied with. Paired '
  'with due_hobbs_hours to show remaining hours, and reset each time the AD '
  'is complied again.';

-- Verify.
select column_name, data_type from information_schema.columns
 where (table_name = 'user_ad_notifications'   and column_name = 'compliance_kind')
    or (table_name = 'user_aircraft_reminders' and column_name = 'complied_hobbs_hours');
