-- ============================================================================
-- Stop the welcome email firing for throwaway test accounts  --  2026-07-31
--
-- Cause of the Resend quota alarm: 88 welcome emails were sent between
-- 14:24 and 16:57 UTC today (net._http_response, all status 200) — one for
-- every disposable QA account created by the test harnesses, not by any real
-- user activity.
--
-- Why creating a user fires it: the admin endpoint
-- POST /auth/v1/admin/users {"email_confirm": true} inserts the row and then
-- sets email_confirmed_at in a follow-up UPDATE. auth.users.confirmed_at is
-- GENERATED from email_confirmed_at, so it goes null -> non-null on that
-- UPDATE and on_auth_user_confirmed fires exactly as designed.
--
-- Two harms, and the second is the worse one:
--   1. 88 of the 100/day Resend quota burned.
--   2. Every one went to an address that does not exist, so every one
--      BOUNCED. Bounce rate is what wrecks a sending domain's reputation,
--      which would eventually hurt delivery of real welcome emails.
--
-- Guard on RFC 2606 reserved TLDs (.invalid / .test), which can never belong
-- to a real user and are never routable, plus RFC 6761's example.com family.
-- The test scripts are moved onto @flyregs.invalid to match, so the guard is
-- exact rather than a guess about what a test address looks like — and it
-- deliberately does NOT skip @flyregs.com, which is a real deliverable
-- domain the team actually uses.
-- ============================================================================

create or replace function public.trigger_send_welcome_email()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if OLD.confirmed_at is null and NEW.confirmed_at is not null then
    -- Never mail a reserved / non-routable test address (RFC 2606, 6761).
    -- These only ever come from the QA harnesses in ac-app/scripts.
    if NEW.email ~* '(\.invalid|\.test|\.example|@example\.(com|net|org))$' then
      return NEW;
    end if;

    perform net.http_post(
      url := 'https://ljzcapedwjqnpmhzqzpz.supabase.co/functions/v1/send-welcome-email',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Mqgh1tUcQpIb8wx4dx4bmCeazU_JS6xonmoObPXb-jc'),
      body := jsonb_build_object('email', NEW.email)
    );
  end if;
  return NEW;
end;
$function$;
