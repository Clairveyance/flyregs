-- 2026-08-13. RC, real device: "this doesn't DO anything. This is a
-- contact search area. it needs to 'connect' to and bring up my iOS phone
-- contact book so i can add person/people to this invite. w/o that, it's
-- useless."
--
-- Root cause of the "useless" feeling: match_contacts_by_email() (see
-- migrations_contact_match.sql) returns ONLY the matched callsigns, with
-- no way to tell the client WHICH of the caller's hashed emails matched
-- which callsign. That made it impossible to build a real "here's your
-- actual contact list, annotated with who's already on FlyRegs" UI --
-- the client could only ever show a flat, unattributed list of matches,
-- which is silently EMPTY for the very common case of a contact having no
-- email on file at all (most people save phone numbers, not emails, for
-- personal contacts) and reads as "does nothing."
--
-- Adds the email_hash the match came from to the return row so the client
-- can map matches back to specific device contacts and show a real,
-- browsable list (which contacts are on FlyRegs vs not), same pattern
-- BulkInviteContactPicker.tsx already proved out for phone-based bulk
-- invites. DROP + CREATE, not CREATE OR REPLACE -- the return signature
-- is changing (adding a column), and CREATE OR REPLACE errors (or
-- silently creates an overload, depending on how the columns differ) on a
-- signature change rather than cleanly replacing it -- see
-- gotcha_create_or_replace_signature_overload.md.
drop function if exists public.match_contacts_by_email(text[]);

create function public.match_contacts_by_email(p_email_hashes text[])
returns table(email_hash text, callsign text)
language sql
security definer
as $$
  select encode(digest(lower(btrim(u.email)), 'sha256'), 'hex') as email_hash, cr.callsign
  from auth.users u
  join callsign_registry cr on cr.user_id = u.id
  join user_streaks us on us.user_id = u.id
  where u.id <> auth.uid()
    and us.leaderboard_opt_in = true
    and u.email is not null
    and encode(digest(lower(btrim(u.email)), 'sha256'), 'hex') = any(p_email_hashes);
$$;

grant execute on function public.match_contacts_by_email(text[]) to authenticated;
