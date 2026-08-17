-- RC: "let's do the phone addition your way. make it optional and prompt it
-- contextually." Extends the existing privacy-preserving contact-match
-- pattern (migrations_contact_match.sql, match_contacts_by_email) to phone
-- numbers -- exactly the extension that migration's own comment anticipated:
-- "If phone auth/profile numbers are ever added, the same shape extends
-- directly." Not phone AUTH (this app stays email/magic-link only) -- just
-- an optional matching-only field in user_metadata, same trust model as a
-- device contact's own unverified saved number.
--
-- Root motivation (RC): most real phone address books have a number saved
-- for someone, not an email -- email-only matching was self-diagnosed in
-- contactMatch.ts's own header comment as "an empty or near-empty list
-- forever" for exactly that reason.
--
-- Same shape as match_contacts_by_email: caller sends only SHA-256 hashes
-- of its own device contacts' normalized numbers, server compares against
-- a hash of each opted-in user's own stored (also normalized) number, and
-- returns only the already-public Callsign for a match -- never a raw
-- phone number in either direction.
--
-- normalize_phone: strips everything but digits, and assumes a bare
-- 10-digit number is a US number missing its country code (the same
-- assumption a US-market app's own users are overwhelmingly likely to
-- share) -- this MUST exactly match the client-side normalizePhone() in
-- contactMatch.ts, or a real match will silently never hash-equal.
create or replace function public.normalize_phone(p_phone text)
returns text
language sql
immutable
as $function$
  select case
    when length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) = 10
      then '1' || regexp_replace(p_phone, '\D', '', 'g')
    else regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
  end
$function$;

create or replace function public.match_contacts_by_phone(p_phone_hashes text[])
returns table(phone_hash text, callsign text)
language plpgsql
security definer
as $function$
begin
  if not public.has_pro_access() then
    raise exception 'Find Friends requires Pro';
  end if;

  return query
  select encode(digest(public.normalize_phone(u.raw_user_meta_data->>'phone_number'), 'sha256'), 'hex') as phone_hash, cr.callsign
  from auth.users u
  join callsign_registry cr on cr.user_id = u.id
  join user_streaks us on us.user_id = u.id
  where u.id <> auth.uid()
    and us.leaderboard_opt_in = true
    and u.raw_user_meta_data->>'phone_number' is not null
    and length(public.normalize_phone(u.raw_user_meta_data->>'phone_number')) > 0
    and encode(digest(public.normalize_phone(u.raw_user_meta_data->>'phone_number'), 'sha256'), 'hex') = any(p_phone_hashes);
end;
$function$;
