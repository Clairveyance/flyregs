-- Fixes a P3 finding from the 2026-08-22 gating audit: get_my_challenges()
-- had no Premium check (Duels is Premium). Low real-world reachability --
-- create_challenge already requires the invitee to be Premium, so a
-- non-Premium caller has zero challenge_participants rows and this
-- already returns empty in practice -- but closes the same PII-enumeration
-- shape (opponent callsign/display_name/avatar) that
-- migrations_fix_duels_pii_leak.sql already closed for
-- get_challengeable_users, for defense-in-depth/consistency.
CREATE OR REPLACE FUNCTION public.get_my_challenges()
 RETURNS TABLE(challenge_id uuid, am_challenger boolean, status text, my_status text, question_count integer, my_answered_count integer, created_at timestamp with time zone, item_types text[], levels text[], category_classes text[], ratings text[], others jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if not exists (select 1 from user_entitlements e where e.user_id = auth.uid() and e.is_premium = true) then
    return;
  end if;
  return query
  select
    c.id,
    c.challenger_id = auth.uid(),
    c.status,
    mycp.status,
    c.question_count,
    (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
       where cq.challenge_id = c.id and ca.user_id = auth.uid())::int,
    c.created_at,
    c.item_types,
    c.levels,
    c.category_classes,
    c.ratings,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', ocp.user_id,
        'label', coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
        'status', ocp.status,
        'answeredCount', (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = c.id and ca.user_id = ocp.user_id),
        'avatarUrl', u.raw_user_meta_data->>'avatar_url',
        'avatarPreset', u.raw_user_meta_data->>'avatar_preset'
      ) order by ocp.is_creator desc, u.email), '[]'::jsonb)
      from challenge_participants ocp
      join auth.users u on u.id = ocp.user_id
      left join callsign_registry cr on cr.user_id = ocp.user_id
      where ocp.challenge_id = c.id and ocp.user_id != auth.uid()
    )
  from challenges c
  join challenge_participants mycp on mycp.challenge_id = c.id and mycp.user_id = auth.uid() and mycp.hidden_at is null
  order by c.created_at desc;
end;
$function$;
