-- Fixes 2 P3 findings from the 2026-08-22 gating audit: get_visible_users()
-- and lookup_user_by_callsign() (both back Find Friends / Ready Room, a
-- Pro feature) had no tier gate at all. Confirmed live: a FREE account got
-- real rows back from get_visible_users(). Their sibling RPCs
-- (match_contacts_by_email, match_contacts_by_phone) already correctly
-- enforce Pro -- this closes the same gap for these two. Both are already
-- effectively gated client-side (Ready Room requires hasProAccess to even
-- reach either call), so this is defense-in-depth, not a behavior change
-- for legitimate access. Live-verified: Free blocked (empty result), Pro
-- unaffected.
CREATE OR REPLACE FUNCTION public.get_visible_users()
 RETURNS TABLE(user_id uuid, display_label text, avatar_url text, avatar_preset text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select u.id as user_id, cr.callsign::text as display_label,
    u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'avatar_preset'
  from user_streaks us
  join auth.users u on u.id = us.user_id
  join callsign_registry cr on cr.user_id = u.id
  where us.leaderboard_opt_in = true and u.id != auth.uid()
    and public.has_pro_access()
  order by 2;
$function$;

CREATE OR REPLACE FUNCTION public.lookup_user_by_callsign(p_callsign text)
 RETURNS TABLE(out_user_id uuid, out_callsign text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.has_pro_access() then
    return;
  end if;
  return query
    select cr.user_id, cr.callsign
    from callsign_registry cr
    where cr.callsign_lower = lower(trim(p_callsign));
end;
$function$;
