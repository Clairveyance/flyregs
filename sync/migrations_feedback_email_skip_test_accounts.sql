-- Stop automated test accounts from emailing real support mail.
--
-- WHY
-- scripts/access_matrix_sweep.py seeds one row per user-owned table to prove a
-- victim's rows are invisible to other identities. One of those tables is
-- feedback_submissions, whose AFTER INSERT trigger sends a real email -- so
-- every access-matrix run delivered "SECRET VICTIM FEEDBACK" to
-- support@flyregs.com. On 2026-09-06 four of the five messages in that inbox
-- were mine, sitting alongside RC's genuine bug report. Support mail is where
-- real user problems arrive; burying it under audit traffic is how a real
-- report gets missed.
--
-- Fixed in the TRIGGER, not the audit script, so it also covers every other
-- test that touches this table now or later.
--
-- 2026-09-07: widened after checking the inbox again. The first version only
-- skipped @flyregs.invalid, but new_tables_rls_fuzz_test.py posts as
-- anon@example.com and a guard test of this very trigger used
-- someone@example.com -- both still emailed support. The filter is now every
-- domain RFC 2606 reserves for exactly this purpose (.invalid, .test,
-- .example, and the example.com/org/net second-level names). None of them can
-- ever belong to a real user, so no genuine submission can match.
--
-- Body below is the existing function verbatim (secret still read from the
-- vault, never inlined) with only the guard added.
create or replace function public.trigger_send_feedback_email()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Disposable test identities never generate support mail. RFC 2606 reserves
  -- all of these; none can be a real user.
  if NEW.user_email is not null and (
       NEW.user_email like '%.invalid'
    or NEW.user_email like '%.test'
    or NEW.user_email like '%.example'
    or NEW.user_email like '%@example.com'
    or NEW.user_email like '%@example.org'
    or NEW.user_email like '%@example.net'
  ) then
    return NEW;
  end if;

  perform net.http_post(
    url := 'https://ljzcapedwjqnpmhzqzpz.supabase.co/functions/v1/send-feedback-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', (select decrypted_secret from vault.decrypted_secrets where name = 'feedback_email_secret')
    ),
    body := jsonb_build_object(
      'id', NEW.id,
      'category', NEW.category,
      'message', NEW.message,
      'user_email', NEW.user_email,
      'app_version', NEW.app_version,
      'platform', NEW.platform,
      'attachment_path', NEW.attachment_path
    )
  );
  return NEW;
end;
$function$;
