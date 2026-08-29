-- ============================================================================
-- Screenshot attachments for Send Feedback                         2026-08-19
-- ============================================================================
--
-- The Report a Bug card's copy already said "screenshots help a lot" but
-- there was no way to actually attach one -- feedback.tsx only ever sent
-- category + free text. RC, asked whether to require sign-in for uploads:
-- "I supposed anyone can upload and send feedback, so signed in/out is
-- okay" -- matches feedback_submissions' own existing anon-or-authenticated
-- insert policy (see migrations_feedback_submissions.sql), so this bucket's
-- policy mirrors it exactly.

alter table public.feedback_submissions
  add column if not exists attachment_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback-attachments', 'feedback-attachments', false, 8388608,
        array['image/jpeg', 'image/png', 'image/heic', 'image/webp'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Write-only, deliberately: anyone can drop a screenshot in, but there is NO
-- select policy on this bucket at all, so nobody can read any object back
-- out via the client -- not even the person who uploaded it. The only
-- reader is send-feedback-email's service_role key, which bypasses RLS
-- entirely. A screenshot may show personal info (a saved reg number, an
-- account email visible on-screen), so this is intentionally more locked
-- down than the public `avatars` bucket -- a blind mail slot, not a shared
-- folder.
drop policy if exists anyone_upload_feedback_attachment on storage.objects;
create policy anyone_upload_feedback_attachment on storage.objects
  for insert
  to anon, authenticated
  with check (bucket_id = 'feedback-attachments');

-- SECURITY NOTE, 2026-08-29: this function's definition is superseded by
-- migrations_email_webhook_secrets_use_vault.sql, which is what's actually
-- live -- the version below is dead code kept only for the file's own
-- history. Its hardcoded Authorization value (redacted below) was found
-- committed in plaintext on this repo's public GitHub remote and has been
-- rotated -- see PROJECT_NOTES/flyregs_gotchas.md for the full incident
-- writeup.
create or replace function public.trigger_send_feedback_email()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform net.http_post(
    url := 'https://ljzcapedwjqnpmhzqzpz.supabase.co/functions/v1/send-feedback-email',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', '<redacted -- see migrations_email_webhook_secrets_use_vault.sql>'),
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
