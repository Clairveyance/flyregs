-- RC circled the trophy-icon rows in the Duels history/pending list and
-- asked for real avatars there too -- same ask as the opponent picker and
-- Ready Room leaderboards, fixed earlier tonight. A duel participant is an
-- even stronger connection than "opted into Show Me" (a real, specific,
-- accepted-or-pending challenge between two accounts), so no new privacy
-- gate is needed -- get_my_challenges() already returns each opponent's
-- Callsign regardless of leaderboard_opt_in, via the participant
-- relationship itself.
create or replace function public.get_my_challenges()
returns table(challenge_id uuid, am_challenger boolean, status text, my_status text, question_count integer, my_answered_count integer, created_at timestamp with time zone, item_types text[], levels text[], category_classes text[], ratings text[], others jsonb)
language plpgsql
security definer
as $function$
begin
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
