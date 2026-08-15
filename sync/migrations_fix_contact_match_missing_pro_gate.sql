-- 2026-08-15, B33-readiness gating audit: match_contacts_by_email() had
-- zero server-side tier check, unlike every sibling privileged RPC (see
-- migrations_fix_folder_invite_premium_gate.sql, migrations_fix_get_study_queue_missing_pro_gate.sql,
-- etc). Client gates around Find Friends are all correct (Ready Room =
-- hasProAccess in ready-room.tsx, My Aircraft/Folder share = isPremium in
-- my-aircraft/[id].tsx + folder/[id].tsx) but none of that matters when the
-- RPC itself is callable directly by any authenticated user regardless of
-- tier. Live-confirmed: calling this RPC as a real Free-tier
-- tiermatrix-free@flyregs.invalid account with a valid payload returned
-- 200 with real matches instead of a 403 -- any signed-in Free user could
-- bypass the UI (devtools/Postman/patched client) and get back real
-- callsigns of any other leaderboard-opted-in user, a feature sold as
-- Pro/Premium everywhere in the app. Made worse by today's "Show Me"
-- toggle rename (account.tsx), which just made the population this RPC
-- exposes bigger and more discoverable.
--
-- Gated at has_pro_access() -- the loosest of the RPC's real callers
-- (Ready Room's Find Friends is Pro-gated; folder/aircraft-invite Find
-- Friends require Premium client-side, which already satisfies Pro).
-- Same signature (p_email_hashes text[] in, table(email_hash text,
-- callsign text) out) so CREATE OR REPLACE is safe, no overload risk --
-- see gotcha_create_or_replace_signature_overload.md.
create or replace function public.match_contacts_by_email(p_email_hashes text[])
returns table(email_hash text, callsign text)
language plpgsql
security definer
as $$
begin
  if not public.has_pro_access() then
    raise exception 'Find Friends requires Pro';
  end if;

  return query
  select encode(digest(lower(btrim(u.email)), 'sha256'), 'hex') as email_hash, cr.callsign
  from auth.users u
  join callsign_registry cr on cr.user_id = u.id
  join user_streaks us on us.user_id = u.id
  where u.id <> auth.uid()
    and us.leaderboard_opt_in = true
    and u.email is not null
    and encode(digest(lower(btrim(u.email)), 'sha256'), 'hex') = any(p_email_hashes);
end;
$$;

grant execute on function public.match_contacts_by_email(text[]) to authenticated;
