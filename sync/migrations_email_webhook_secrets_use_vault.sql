-- INCIDENT FIX, 2026-08-29 -- see PROJECT_NOTES/flyregs_gotchas.md's
-- "webhook secrets committed in plaintext" entry for the full writeup.
--
-- trigger_send_welcome_email() and trigger_send_feedback_email() (both
-- originally shipped in migrations_welcome_email_guard.sql /
-- migrations_feedback_submissions.sql / migrations_feedback_attachment.sql)
-- had the literal Authorization value each edge function checks typed
-- directly into their net.http_post() call -- the only place in this whole
-- project a secret was ever hardcoded into a committed file, rather than
-- loaded from an untracked .env file the way every scraper/script in sync/
-- already does it. Both files, and both secrets, had been sitting on this
-- repo's PUBLIC GitHub remote (Clairveyance/flyregs) since the day they were
-- written -- found and rotated the same session this was discovered, not
-- left open.
--
-- .env files aren't reachable from inside a Postgres trigger, which is
-- presumably why whoever wrote these reached for a literal instead -- there
-- was no established "how do I keep a secret out of a migration file when
-- the caller is SQL, not a script" pattern in this codebase before now.
-- This migration establishes that pattern: Supabase Vault (already enabled
-- on this project, `supabase_vault` extension). The actual secret VALUES
-- were created directly against the live database via a one-off, never-
-- committed scratchpad SQL file (`vault.create_secret(...)`) -- this
-- migration only ever references them by NAME
-- (vault.decrypted_secrets.name), so it's safe to commit: reading this file
-- gives you zero information about what the actual secret values are.
--
-- New secrets set on both edge functions via the new
-- scripts/set_edge_function_secret.py (also added this session) before this
-- migration ran, so there's no window where the DB is calling with a value
-- neither function recognizes yet.
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
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_email_secret')
      ),
      body := jsonb_build_object('email', NEW.email)
    );
  end if;
  return NEW;
end;
$function$;

create or replace function public.trigger_send_feedback_email()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
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
