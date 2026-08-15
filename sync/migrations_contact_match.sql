-- Privacy-preserving contact discovery, core layer -- 2026-08-13. RC:
-- "yes build the contact/invite feature... we need a way to invite people
-- to those things, while both allowing the user to select contacts from
-- their phone like normal, and keep the group from seeing everyone else's
-- personal info."
--
-- Scope note: every existing invite path in this app (Ready Room browse,
-- invite_aircraft_collaborator(), the folder equivalent) already targets a
-- person by their FlyRegs Callsign, resolved server-side via
-- lookup_user_by_callsign() -- see migrations_aircraft_pending_invites.sql.
-- This migration does NOT touch any of that. It only adds the missing
-- piece in front of it: given a set of the CALLER's own phone contacts,
-- tell them which ones are already FlyRegs users (and their callsign), so
-- they don't have to already know someone's exact in-app handle to invite
-- them. The client then hands that callsign to the SAME existing invite
-- RPCs, unchanged.
--
-- Same industry-standard pattern as WhatsApp/Signal/Instagram contact
-- discovery: the client hashes its own contacts locally (never sends raw
-- email/phone), the server compares against a hash of its OWN users'
-- already-on-file identifiers, and only returns already-public profile
-- fields (Callsign) for a match -- never the matched user's raw email back
-- to the searcher, and never the searcher's contacts to anyone else.
--
-- Phone-based matching is NOT built here -- checked live, auth.users has
-- ZERO rows with a phone number on file (this app is email/magic-link
-- only) -- there is nothing to match a phone contact against yet. Only
-- email is wired up. If phone auth/profile numbers are ever added, the
-- same shape extends directly.
--
-- Gated by the SAME leaderboard_opt_in flag Duels discoverability already
-- uses (user_streaks.leaderboard_opt_in) -- consistent with the one
-- existing "discoverable to people who already have some signal about
-- you" convention in this app, rather than inventing a second opt-in
-- concept. A user who's opted out of the Duels leaderboard is also opted
-- out of being found via contact match.
create or replace function public.match_contacts_by_email(p_email_hashes text[])
returns table(callsign text)
language sql
security definer
as $$
  select cr.callsign
  from auth.users u
  join callsign_registry cr on cr.user_id = u.id
  join user_streaks us on us.user_id = u.id
  where u.id <> auth.uid()
    and us.leaderboard_opt_in = true
    and u.email is not null
    and encode(digest(lower(btrim(u.email)), 'sha256'), 'hex') = any(p_email_hashes);
$$;

grant execute on function public.match_contacts_by_email(text[]) to authenticated;
