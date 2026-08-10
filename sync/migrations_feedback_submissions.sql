-- ============================================================================
-- Server-side Send Feedback pipeline, replacing the client-only mail handoff
--                                                                  2026-08-10
-- ============================================================================
--
-- RC, 2026-08-10: "get into email and make sure nothing's wrong w/ the
-- pipeline. a couple people said they sent bug reports through the app, but
-- we haven't received their emails."
--
-- Root cause, found by reading the actual client code (Gmail access to
-- verify the support@flyregs.com inbox itself needs RC's own OAuth
-- authorization -- not something this session can complete unattended;
-- flagged separately): Send Feedback (src/app/feedback.tsx) used
-- expo-mail-composer, falling back to a raw Linking.openURL('mailto:...')
-- when MailComposer.isAvailableAsync() is false. Two confirmed, real
-- failure modes, neither of which leaves ANY trace anywhere:
--   1. On WEB: ExpoMailComposer.web.js's isAvailableAsync() always returns
--      true (just `typeof window !== 'undefined'`), but composeAsync() only
--      does `window.open('mailto:...')` and can NEVER report status
--      SENT -- only UNDETERMINED. feedback.tsx only shows its "Sent!" toast
--      and clears the draft on status === SENT, so on web this can never
--      fire, but more importantly the actual send is delegated entirely to
--      whatever external mail client the browser opens.
--   2. On NATIVE: isAvailableAsync() wraps MFMailComposeViewController.
--      canSendMail(), which is false for any device with no account added
--      to Settings > Mail -- true for plenty of real users who only use a
--      third-party mail app. That falls through to the same raw
--      Linking.openURL('mailto:...') -- confirmed actually failing on a
--      real device via Sentry ("Error: Unable to open URL:
--      mailto:support@flyregs.com", 2026-07-18).
-- In both cases, whether the email actually reaches support@flyregs.com
-- depends entirely on the user's own device mail configuration and them
-- manually completing a send in an external app -- exactly the unreliable,
-- unverifiable handoff this project's own [[feedback_data_reliability_mandate]]
-- says not to depend on for anything that matters.
--
-- FIX: the app now writes feedback directly to this table first -- a real,
-- durable, queryable row that exists the instant Send is tapped,
-- independent of whether any external mail app ever opens or whatever the
-- user does next. A trigger relays it via Resend (send-feedback-email
-- Edge Function, same pattern as send-welcome-email) server-side. If Resend
-- itself fails, email_status='failed' + email_error is captured on the row
-- -- the feedback is NEVER silently lost even if the relay email fails,
-- since the message text is already durably stored regardless.
-- ============================================================================

create table if not exists public.feedback_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  category text not null,
  message text not null,
  app_version text,
  platform text,
  created_at timestamptz not null default now(),
  email_status text not null default 'pending',
  email_error text
);

alter table public.feedback_submissions enable row level security;

-- Write-only from the client's side (matches device_signup_attempts'
-- pattern): anyone (signed in or not -- Send Feedback works without auth)
-- can insert their own submission, nobody can read/update/delete their own
-- or anyone else's row via the client. The Edge Function updates
-- email_status via the service_role key, which bypasses RLS entirely.
drop policy if exists feedback_submissions_insert on public.feedback_submissions;
create policy feedback_submissions_insert on public.feedback_submissions
  for insert
  to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

-- RLS policies alone don't grant table-level access -- PostgREST also
-- needs the base GRANT (confirmed against synced_bookmarks' own grants,
-- the existing client-insert convention in this schema).
grant insert on public.feedback_submissions to anon, authenticated;

create or replace function public.trigger_send_feedback_email()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform net.http_post(
    url := 'https://ljzcapedwjqnpmhzqzpz.supabase.co/functions/v1/send-feedback-email',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'G855TluvowBgTcnrU7OgiG0h5wfC_wIIbhmED0APWXw'),
    body := jsonb_build_object(
      'id', NEW.id,
      'category', NEW.category,
      'message', NEW.message,
      'user_email', NEW.user_email,
      'app_version', NEW.app_version,
      'platform', NEW.platform
    )
  );
  return NEW;
end;
$function$;

drop trigger if exists trg_send_feedback_email on public.feedback_submissions;
create trigger trg_send_feedback_email
  after insert on public.feedback_submissions
  for each row execute function public.trigger_send_feedback_email();
