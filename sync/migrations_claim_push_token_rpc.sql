-- 2026-08-29, full-sweep pass 5 (Onboarding/Auth). Companion to this
-- session's push_tokens cross-account-leak fix in src/lib/notifications.ts.
--
-- push_tokens' own RLS policy (users_manage_own_push_tokens) is
-- `auth.uid() = user_id` for ALL commands, which is correct and exactly
-- what you want for every normal read/write on this table -- but it means
-- a plain client-side
--   supabase.from('push_tokens').delete().eq('expo_push_token', t).neq('user_id', me)
-- silently deletes ZERO rows: RLS filters the row out before the DELETE
-- ever runs, no error, no rows affected, nothing to notice. Caught this
-- live before shipping it -- the first version of ensurePushTokenRegistered's
-- claim-on-register fix would have looked complete (typechecked, read
-- correctly) while doing nothing at all, which is exactly the "built but
-- inert" shape this whole sweep exists to catch.
--
-- Narrow, single-purpose SECURITY DEFINER RPC instead, matching this
-- project's own established pattern for "needs to touch a row outside the
-- caller's own RLS visibility, but only in one safe, specific way" (see
-- get_collaboration_invite_push_target, invite_folder_collaborator, the
-- aircraft collaborator role-change RPC). Takes only the token -- the
-- caller can never specify WHOSE row to delete, only "not mine, for this
-- exact device token I already legitimately hold" -- so there's no way to
-- use this to delete an arbitrary other user's row.
create or replace function public.claim_push_token(p_token text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  delete from push_tokens
   where expo_push_token = p_token
     and user_id <> auth.uid();
end;
$function$;

revoke all on function public.claim_push_token(text) from public, anon;
grant execute on function public.claim_push_token(text) to authenticated;
