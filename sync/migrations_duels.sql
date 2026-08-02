-- ============================================================================
-- Duels correctness + authorization fixes  --  2026-07-31
--
-- Found by scripts/duel_e2e_test.py, the first end-to-end play-through of a
-- duel with two real authenticated accounts (real user JWTs, not the service
-- key, so RLS/auth.uid() are genuinely exercised).
--
-- D1  get_challenge_results leaked the CORRECT ANSWER to every question, plus
--     every other player's answer/time, to any participant at any time --
--     including before they had played a single question. The documented
--     contract (src/lib/challenges.ts) is that this stays hidden until the
--     whole challenge completes. The app UI only calls it in the completed
--     phase, so this was invisible in-app but trivially exploitable against
--     the API, and it feeds real leaderboard win/loss stats.
--
-- D2  get_challenge_standings had NO participant check at all -- any signed-in
--     user could read any duel's scores AND player display names by id.
--     (get_challenge_results already guarded this; standings never did.)
--
-- D3  A duel auto-completed as soon as the CREATOR answered their last
--     question, because completion compared answered-count against
--     status='active' participants only -- and an invitee who hasn't accepted
--     yet is status='pending'. Creator solo-finishes -> active_count = 1 ->
--     "everyone" has answered -> challenge completed, creator banks a win and
--     the DUEL_FIRST_WIN coin against an opponent who never played.
--
-- D4  Direct consequence of D3: the invitee then accepts, is served question
--     1 by get_next_challenge_question (which only checks participant status,
--     not challenge status), and every submit_challenge_answer throws
--     'Question not found or challenge not active for you'. The duel is
--     permanently unplayable for them with no UI path out.
--
-- Also: respond_to_challenge accepted invites into already-finished duels.
-- ============================================================================

-- ---------------------------------------------------------------- D3 / D4
-- Completion now requires: no invitee still pending, at least 2 active
-- players, and every active player finished. If every invitee DECLINED, the
-- duel is cancelled rather than completed, so nobody banks a phantom win.
create or replace function public.submit_challenge_answer(
  p_question_id uuid, p_answer_text text, p_time_ms integer
)
returns table(is_correct boolean, correct_answer text, others_answered_count integer,
              others_total_count integer, challenge_completed boolean, new_coins text[])
language plpgsql
security definer
as $function$
declare
  v_challenge_id uuid;
  v_term text;
  v_is_correct boolean;
  v_total_questions int;
  v_active_count int;
  v_pending_count int;
  v_both_answered_count int;
  v_new_coins text[] := '{}';
  v_wins int;
  v_rank record;
begin
  select cq.challenge_id,
    case cq.item_type
      when 'pcg' then (select pt.term from pcg_terms pt where pt.term = cq.item_id limit 1)
      else cq.item_id
    end
  into v_challenge_id, v_term
  from challenge_questions cq
  join challenges c on c.id = cq.challenge_id
  where cq.id = p_question_id
    and exists (select 1 from challenge_participants cp where cp.challenge_id = cq.challenge_id and cp.user_id = auth.uid() and cp.status = 'active')
    and c.status = 'active';

  if not found then
    raise exception 'Question not found or challenge not active for you';
  end if;

  v_is_correct := (p_answer_text = v_term);

  insert into challenge_answers (challenge_question_id, user_id, answer_text, is_correct, time_ms)
  values (p_question_id, auth.uid(), p_answer_text, v_is_correct, p_time_ms)
  on conflict (challenge_question_id, user_id) do nothing;

  is_correct := v_is_correct;
  correct_answer := v_term;

  select count(*) into v_active_count from challenge_participants where challenge_id = v_challenge_id and status = 'active';
  select count(*) into v_pending_count from challenge_participants where challenge_id = v_challenge_id and status = 'pending';
  select count(*) into others_answered_count
  from challenge_answers ca
  where ca.challenge_question_id = p_question_id and ca.user_id != auth.uid();
  others_total_count := v_active_count - 1;

  select count(*) into v_total_questions from challenge_questions where challenge_id = v_challenge_id;
  select count(distinct cp.user_id) into v_both_answered_count
  from challenge_participants cp
  where cp.challenge_id = v_challenge_id and cp.status = 'active'
    and (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
         where cq.challenge_id = v_challenge_id and ca.user_id = cp.user_id) = v_total_questions;

  -- D3: an invitee who hasn't responded yet is 'pending', not 'active'. A duel
  -- is only over once nobody is still deciding AND there is somebody to have
  -- duelled. v_total_questions > 0 additionally stops a filter combination
  -- that produced an empty question pool from "completing" instantly.
  challenge_completed := v_pending_count = 0
                     and v_active_count >= 2
                     and v_total_questions > 0
                     and v_both_answered_count = v_active_count;

  -- Every invitee declined: close the duel out with no result rather than
  -- leaving it active forever or crowning the creator.
  if v_pending_count = 0 and v_active_count < 2 then
    update challenges set status = 'cancelled', completed_at = now()
    where id = v_challenge_id and status = 'active';
  end if;

  if challenge_completed then
    update challenges set status = 'completed', completed_at = now() where id = v_challenge_id and status = 'active';

    -- Rank every active participant: most correct answers wins outright;
    -- ties are broken only by time on the questions where EVERY member of
    -- that specific tied group answered correctly (a direct N-player
    -- generalization of the 2-player "joint-correct time" rule -- a
    -- question you missed never counts against or for you, and a question
    -- someone outside your tied group missed doesn't touch your tiebreak
    -- either).
    for v_rank in
      with active_participants as (
        select cp.user_id from challenge_participants cp
        where cp.challenge_id = v_challenge_id and cp.status = 'active'
      ),
      correct_counts as (
        select ap.user_id,
          (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
             where cq.challenge_id = v_challenge_id and ca.user_id = ap.user_id and ca.is_correct) as correct_count
        from active_participants ap
      ),
      qualifying_questions as (
        select cc1.user_id, cq.id as question_id
        from correct_counts cc1
        cross join challenge_questions cq
        where cq.challenge_id = v_challenge_id
        and not exists (
          select 1 from correct_counts cc2
          where cc2.correct_count = cc1.correct_count
          and not exists (
            select 1 from challenge_answers ca
            where ca.challenge_question_id = cq.id and ca.user_id = cc2.user_id and ca.is_correct
          )
        )
      ),
      tiebreak_times as (
        select qq.user_id, coalesce(sum(ca.time_ms), 0) as tiebreak_ms
        from qualifying_questions qq
        left join challenge_answers ca on ca.challenge_question_id = qq.question_id and ca.user_id = qq.user_id
        group by qq.user_id
      )
      select cc.user_id, cc.correct_count, coalesce(tt.tiebreak_ms, 0) as tiebreak_ms,
        rank() over (order by cc.correct_count desc, coalesce(tt.tiebreak_ms, 0) asc) as final_rank,
        count(*) over (partition by cc.correct_count, coalesce(tt.tiebreak_ms, 0)) as tie_group_size
      from correct_counts cc
      left join tiebreak_times tt on tt.user_id = cc.user_id
    loop
      if v_rank.final_rank = 1 and v_rank.tie_group_size > 1 then
        insert into user_duel_stats (user_id, ties, updated_at) values (v_rank.user_id, 1, now())
          on conflict (user_id) do update set ties = user_duel_stats.ties + 1, updated_at = now();
      elsif v_rank.final_rank = 1 then
        insert into user_duel_stats (user_id, wins, updated_at) values (v_rank.user_id, 1, now())
          on conflict (user_id) do update set wins = user_duel_stats.wins + 1, updated_at = now()
          returning wins into v_wins;

        if v_wins >= 1 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_FIRST_WIN') then
          insert into user_coins (user_id, coin_code) values (v_rank.user_id, 'DUEL_FIRST_WIN');
          if auth.uid() = v_rank.user_id then v_new_coins := array_append(v_new_coins, 'DUEL_FIRST_WIN'); end if;
        end if;
        if v_wins >= 5 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_5_WINS') then
          insert into user_coins (user_id, coin_code) values (v_rank.user_id, 'DUEL_5_WINS');
          if auth.uid() = v_rank.user_id then v_new_coins := array_append(v_new_coins, 'DUEL_5_WINS'); end if;
        end if;
        if v_wins >= 25 and not exists (select 1 from user_coins where user_id = v_rank.user_id and coin_code = 'DUEL_25_WINS') then
          insert into user_coins (user_id, coin_code) values (v_rank.user_id, 'DUEL_25_WINS');
          if auth.uid() = v_rank.user_id then v_new_coins := array_append(v_new_coins, 'DUEL_25_WINS'); end if;
        end if;
      else
        insert into user_duel_stats (user_id, losses, updated_at) values (v_rank.user_id, 1, now())
          on conflict (user_id) do update set losses = user_duel_stats.losses + 1, updated_at = now();
      end if;
    end loop;
  end if;

  new_coins := v_new_coins;
  return next;
end;
$function$;

-- ---------------------------------------------------------------- D4 guard
-- Don't let anyone accept their way into a duel that is already over.
create or replace function public.respond_to_challenge(p_challenge_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
as $function$
begin
  if p_accept and not exists (
    select 1 from challenges c where c.id = p_challenge_id and c.status = 'active'
  ) then
    raise exception 'This duel is no longer active';
  end if;

  update challenge_participants
  set status = case when p_accept then 'active' else 'declined' end,
      responded_at = now()
  where challenge_id = p_challenge_id
    and user_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'Challenge not found or not pending your response';
  end if;

  -- Last invitee declining ends the duel; nobody is left to play against.
  if not p_accept
     and not exists (select 1 from challenge_participants cp
                     where cp.challenge_id = p_challenge_id and cp.status = 'pending')
     and (select count(*) from challenge_participants cp
          where cp.challenge_id = p_challenge_id and cp.status = 'active') < 2 then
    update challenges set status = 'cancelled', completed_at = now()
    where id = p_challenge_id and status = 'active';
  end if;
end;
$function$;

-- ---------------------------------------------------------------- D1
-- Before completion: only questions the caller has ALREADY answered come
-- back (so the term/definition can't be used to pre-read the answer key),
-- and other players' answers stay masked. After completion: full reveal,
-- exactly as before.
create or replace function public.get_challenge_results(p_challenge_id uuid)
returns table(sort_order integer, item_type text, term text, definition text, answers jsonb)
language plpgsql
security definer
as $function$
declare
  v_completed boolean;
begin
  if not exists (select 1 from challenge_participants cp where cp.challenge_id = p_challenge_id and cp.user_id = auth.uid()) then
    raise exception 'Challenge not found';
  end if;

  select c.status = 'completed' into v_completed from challenges c where c.id = p_challenge_id;
  v_completed := coalesce(v_completed, false);

  return query
  select
    cq.sort_order, cq.item_type,
    case cq.item_type
      when 'pcg' then (select pt.term from pcg_terms pt where pt.term = cq.item_id limit 1)
      else cq.item_id
    end,
    case cq.item_type
      when 'pcg' then (select pt.definition from pcg_terms pt where pt.term = cq.item_id limit 1)
      when 'far' then (select f.title from far_sections f where f.section_number = cq.item_id)
      when 'aim' then (select a.title from aim_paragraphs a where a.paragraph_number = cq.item_id)
      when 'ac' then (select c.title from advisory_circulars c where c.document_number = cq.item_id)
    end,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', cp.user_id,
        'label', coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
        'isMe', cp.user_id = auth.uid(),
        'answerText', case when v_completed or cp.user_id = auth.uid() then ca.answer_text else null end,
        'isCorrect',  case when v_completed or cp.user_id = auth.uid() then ca.is_correct else null end,
        'timeMs',     case when v_completed or cp.user_id = auth.uid() then ca.time_ms else null end
      ) order by cp.is_creator desc, u.email), '[]'::jsonb)
      from challenge_participants cp
      join auth.users u on u.id = cp.user_id
      left join challenge_answers ca on ca.challenge_question_id = cq.id and ca.user_id = cp.user_id
      where cp.challenge_id = p_challenge_id and cp.status = 'active'
    )
  from challenge_questions cq
  where cq.challenge_id = p_challenge_id
    and (v_completed or exists (
      select 1 from challenge_answers ca2
      where ca2.challenge_question_id = cq.id and ca2.user_id = auth.uid()
    ))
  order by cq.sort_order;
end;
$function$;

-- ---------------------------------------------------------------- D2
-- Participants only, and before completion a caller sees only their own row
-- (another player's running score is exactly the "hidden until the end"
-- information D1 is about).
create or replace function public.get_challenge_standings(p_challenge_id uuid)
returns table(user_id uuid, label text, is_me boolean, correct_count integer,
              tiebreak_ms integer, final_rank integer, tie_group_size integer)
language plpgsql
stable
security definer
as $function$
declare
  v_completed boolean;
begin
  if not exists (select 1 from challenge_participants cp
                 where cp.challenge_id = p_challenge_id and cp.user_id = auth.uid()) then
    raise exception 'Challenge not found';
  end if;

  select c.status = 'completed' into v_completed from challenges c where c.id = p_challenge_id;
  v_completed := coalesce(v_completed, false);

  return query
  with active_participants as (
    select cp.user_id from challenge_participants cp
    where cp.challenge_id = p_challenge_id and cp.status = 'active'
  ),
  correct_counts as (
    select ap.user_id,
      (select count(*)::int from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
         where cq.challenge_id = p_challenge_id and ca.user_id = ap.user_id and ca.is_correct) as correct_count
    from active_participants ap
  ),
  qualifying_questions as (
    select cc1.user_id, cq.id as question_id
    from correct_counts cc1
    cross join challenge_questions cq
    where cq.challenge_id = p_challenge_id
    and not exists (
      select 1 from correct_counts cc2
      where cc2.correct_count = cc1.correct_count
      and not exists (
        select 1 from challenge_answers ca
        where ca.challenge_question_id = cq.id and ca.user_id = cc2.user_id and ca.is_correct
      )
    )
  ),
  tiebreak_times as (
    select qq.user_id, coalesce(sum(ca.time_ms), 0)::int as tiebreak_ms
    from qualifying_questions qq
    left join challenge_answers ca on ca.challenge_question_id = qq.question_id and ca.user_id = qq.user_id
    group by qq.user_id
  ),
  ranked as (
    select cc.user_id,
      coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)) as label,
      cc.user_id = auth.uid() as is_me,
      cc.correct_count,
      coalesce(tt.tiebreak_ms, 0) as tiebreak_ms,
      rank() over (order by cc.correct_count desc, coalesce(tt.tiebreak_ms, 0) asc)::int as final_rank,
      count(*) over (partition by cc.correct_count, coalesce(tt.tiebreak_ms, 0))::int as tie_group_size
    from correct_counts cc
    join auth.users u on u.id = cc.user_id
    left join tiebreak_times tt on tt.user_id = cc.user_id
  )
  select r.user_id, r.label, r.is_me, r.correct_count, r.tiebreak_ms, r.final_rank, r.tie_group_size
  from ranked r
  where v_completed or r.is_me
  order by r.final_rank, r.label;
end;
$function$;
