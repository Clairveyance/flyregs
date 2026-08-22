-- Duel forfeit + real cancel-propagation, 2026-08-22
--
-- RC's exact rule (verbatim): "if the person starts the game and doesn't
-- finish it, then they forfeit -- they need to be told that they forfeit
-- and the other person automatically becomes a winner. A person can send a
-- challenge and then delete the challenge before they start playing and the
-- challenge just goes away even if the other person has already started,
-- but once they start the challenge and hit go on the first question, they
-- are not allowed to leave the game without forfeiting and can't delete the
-- challenge without also forfeiting."
--
-- Two confirmed, previously-unbuilt gaps, both live-verified against
-- production before this fix:
--
-- BUG 1 (forfeit never existed at all): finalize_challenge_if_done only
-- ever completes a challenge once EVERY 'active' participant has answered
-- EVERY question -- there was no concept of "gave up." A real production
-- duel (id 8b19ea9e-bc36-4e2a-b791-c4c2365f726e, created 2026-08-16) sat
-- 'active' for 6 days with both participants stalled (2/3 and 1/3
-- answered) -- permanently stuck, exactly as this bug predicts, with no
-- server-side path to ever resolve it and no client affordance to leave.
--
-- BUG 2 (delete doesn't propagate): the ONLY "delete" the client could call
-- was hide_challenge_from_history(), a strictly PER-USER cosmetic hide
-- (challenge_participants.hidden_at on the caller's own row) that never
-- touches the shared `challenges` row or the other participant(s) at all --
-- confirmed by reading it (migrations_duel_history_swipe_delete.sql). A
-- challenger who "deletes" a still-active/pending invite leaves it fully
-- visible and playable on the recipient's side forever -- exactly RC's
-- report ("it's just allowing the opponent to play the duel, but there's
-- nobody on the other side of that game anymore").
--
-- Fix shape: a single, server-observable signal -- "have I answered at
-- least one question in this challenge" -- decides which of two NEW,
-- narrow RPCs applies. Below that threshold, exiting is free (cancel_
-- challenge). At or above it, exiting forfeits (forfeit_challenge). Both
-- are called from the client's existing swipe-to-delete gesture (routed by
-- MyChallenge.status/myAnsweredCount, see challenges/index.tsx) and from a
-- new back-button guard on the play screen (challenges/[id].tsx) -- neither
-- invents new UI beyond wiring the existing delete/back affordances to the
-- correct one of these three outcomes (decline / cancel / forfeit).

-- ---------------------------------------------------------------- schema
-- New terminal status for a participant who abandoned an in-progress duel.
-- Distinct from 'declined' (never accepted at all) and from account
-- deletion's cascade-away (on_participant_deleted, migrations_duels_5.sql)
-- -- a forfeiter's row stays in place so their partial answers/results
-- still show, they just always rank last.
alter table public.challenge_participants
  drop constraint if exists challenge_participants_status_check;
alter table public.challenge_participants
  add constraint challenge_participants_status_check
  check (status in ('pending', 'active', 'declined', 'forfeited'));

-- ---------------------------------------------------------------- finalize
-- Rewritten to treat 'forfeited' as a third, always-loses tier: a forfeiter
-- is still scored/ranked (their real answers count, same "real competition"
-- principle already established for a lapsed-Premium participant in
-- migrations_fix_duel_finalize_entitlement_check.sql) but NEVER outranks a
-- still-active participant, regardless of correct-count -- RC: forfeiting
-- is an automatic loss, full stop. And when exactly one active participant
-- remains after a forfeit (the overwhelmingly common 2-player case), that
-- survivor is finalized as the winner immediately, without needing to
-- finish every remaining question themselves -- RC: "the other person
-- automatically becomes a winner," not "gets to keep playing for it."
create or replace function public.finalize_challenge_if_done(p_challenge_id uuid)
 returns text[]
 language plpgsql
 security definer
as $function$
declare
  v_total_questions int;
  v_active_count int;
  v_pending_count int;
  v_forfeited_count int;
  v_all_answered_count int;
  v_new_coins text[] := '{}';
  v_wins int;
  v_rank record;
begin
  select count(*) into v_active_count from challenge_participants
    where challenge_id = p_challenge_id and status = 'active';
  select count(*) into v_pending_count from challenge_participants
    where challenge_id = p_challenge_id and status = 'pending';
  select count(*) into v_forfeited_count from challenge_participants
    where challenge_id = p_challenge_id and status = 'forfeited';
  select count(*) into v_total_questions from challenge_questions
    where challenge_id = p_challenge_id;

  if v_pending_count = 0 and v_active_count < 2 then
    if not (v_active_count = 1 and v_forfeited_count > 0) then
      -- Nobody left actively playing and nobody forfeited to get here
      -- (everyone simply declined, or the last account got deleted):
      -- close it out with no winner, same as always.
      update challenges set status = 'cancelled', completed_at = now()
      where id = p_challenge_id and status = 'active';
      return v_new_coins;
    end if;
    -- else: exactly one active participant survives a real forfeit --
    -- fall through to scoring below and finalize them as the winner right
    -- now, without waiting on them to answer anything further.
  elsif v_pending_count > 0 or v_total_questions = 0 then
    return v_new_coins;
  else
    -- 2+ active participants, nobody pending: only finalize once every
    -- ACTIVE (non-forfeited) participant has answered every question. A
    -- forfeited participant is deliberately excluded from this gate --
    -- they've dropped out and will never answer the rest, same reasoning
    -- 'declined' already gets.
    select count(distinct cp.user_id) into v_all_answered_count
    from challenge_participants cp
    where cp.challenge_id = p_challenge_id and cp.status = 'active'
      and (select count(*) from challenge_answers ca
           join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = p_challenge_id and ca.user_id = cp.user_id) = v_total_questions;

    if v_all_answered_count <> v_active_count then
      return v_new_coins;
    end if;
  end if;

  update challenges set status = 'completed', completed_at = now()
  where id = p_challenge_id and status = 'active';
  if not found then
    -- Already finalized by a concurrent call; don't double-award.
    return v_new_coins;
  end if;

  -- Rank every active-or-forfeited participant: an 'active' participant
  -- always outranks a 'forfeited' one regardless of correct_count (the
  -- `case when status='forfeited' then 1 else 0 end` tier, sorted first);
  -- within the same tier, most correct answers wins, ties broken by time
  -- on jointly-correct questions -- identical to the pre-existing rule,
  -- just partitioned by tier too so a forfeiter's own correct-count can't
  -- leak into an active player's tiebreak group or vice versa.
  for v_rank in
    with scored_participants as (
      select cp.user_id, cp.status from challenge_participants cp
      where cp.challenge_id = p_challenge_id and cp.status in ('active', 'forfeited')
    ),
    correct_counts as (
      select sp.user_id, sp.status,
        (select count(*) from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
           where cq.challenge_id = p_challenge_id and ca.user_id = sp.user_id and ca.is_correct) as correct_count
      from scored_participants sp
    ),
    qualifying_questions as (
      select cc1.user_id, cq.id as question_id
      from correct_counts cc1
      cross join challenge_questions cq
      where cq.challenge_id = p_challenge_id
      and not exists (
        select 1 from correct_counts cc2
        where cc2.correct_count = cc1.correct_count and cc2.status = cc1.status
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
    select cc.user_id, cc.status, cc.correct_count, coalesce(tt.tiebreak_ms, 0) as tiebreak_ms,
      rank() over (
        order by (case when cc.status = 'forfeited' then 1 else 0 end),
                 cc.correct_count desc, coalesce(tt.tiebreak_ms, 0) asc
      ) as final_rank,
      count(*) over (
        partition by (case when cc.status = 'forfeited' then 1 else 0 end), cc.correct_count, coalesce(tt.tiebreak_ms, 0)
      ) as tie_group_size
    from correct_counts cc
    left join tiebreak_times tt on tt.user_id = cc.user_id
  loop
    -- Revenue-integrity check (unchanged from migrations_fix_duel_finalize_
    -- entitlement_check.sql): skip writing ANY permanent record for a
    -- participant whose Premium has lapsed since they accepted.
    if not exists (select 1 from user_entitlements ue where ue.user_id = v_rank.user_id and ue.is_premium = true) then
      continue;
    end if;

    if v_rank.status = 'forfeited' then
      -- Forfeiting is always a loss, never a tie/win -- even if a
      -- forfeiter numerically ties another forfeiter, neither of them beat
      -- anyone who stayed active.
      insert into user_duel_stats (user_id, losses, updated_at) values (v_rank.user_id, 1, now())
        on conflict (user_id) do update set losses = user_duel_stats.losses + 1, updated_at = now();
    elsif v_rank.final_rank = 1 and v_rank.tie_group_size > 1 then
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

  return v_new_coins;
end;
$function$;

-- ---------------------------------------------------------------- forfeit
-- Called when a participant who has ALREADY answered >=1 question in this
-- duel either backs out of the play screen (challenges/[id].tsx) or swipe-
-- deletes it from the Duels list (challenges/index.tsx) -- RC: "once they
-- start the challenge and hit go on the first question, they are not
-- allowed to leave the game without forfeiting." Re-derives "started" from
-- challenge_answers itself rather than trusting a client-supplied flag.
create or replace function public.forfeit_challenge(p_challenge_id uuid)
 returns void
 language plpgsql
 security definer
as $function$
declare
  v_answered_count int;
begin
  if not exists (
    select 1 from challenge_participants
    where challenge_id = p_challenge_id and user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'Not an active participant in this duel';
  end if;

  select count(*) into v_answered_count
  from challenge_answers ca
  join challenge_questions cq on cq.id = ca.challenge_question_id
  where cq.challenge_id = p_challenge_id and ca.user_id = auth.uid();

  if v_answered_count = 0 then
    raise exception 'You have not answered any questions yet -- cancel the duel instead of forfeiting it';
  end if;

  update challenge_participants
  set status = 'forfeited', responded_at = now()
  where challenge_id = p_challenge_id and user_id = auth.uid();

  perform finalize_challenge_if_done(p_challenge_id);
end;
$function$;

-- ---------------------------------------------------------------- cancel
-- The clean, no-penalty exit for someone who has NOT yet answered a single
-- question in this duel -- RC: "before you've answered your first
-- question, deleting/leaving is a clean no-op cancellation." Two shapes,
-- one RPC (the client doesn't need to know which role it's calling as):
--   - the CREATOR cancelling kills the WHOLE challenge, even if another
--     invitee already started playing -- RC: "the challenge just goes away
--     even if the other person has already started." Their in-progress
--     answers are simply discarded; no stats are written for anyone.
--   - a non-creator participant (still pending, or accepted but hasn't
--     played) leaving only removes THEM -- same shape as declining
--     (respond_to_challenge's own D5 logic), re-running finalize in case
--     that's what completes the duel for whoever's left.
create or replace function public.cancel_challenge(p_challenge_id uuid)
 returns void
 language plpgsql
 security definer
as $function$
declare
  v_is_creator boolean;
  v_answered_count int;
begin
  select is_creator into v_is_creator
  from challenge_participants
  where challenge_id = p_challenge_id and user_id = auth.uid();

  if v_is_creator is null then
    raise exception 'Not a participant in this duel';
  end if;

  select count(*) into v_answered_count
  from challenge_answers ca
  join challenge_questions cq on cq.id = ca.challenge_question_id
  where cq.challenge_id = p_challenge_id and ca.user_id = auth.uid();

  if v_answered_count > 0 then
    raise exception 'You have already started this duel -- forfeit it instead of cancelling';
  end if;

  if v_is_creator then
    update challenges set status = 'cancelled', completed_at = now()
    where id = p_challenge_id and status = 'active';
  else
    update challenge_participants
    set status = 'declined', responded_at = now()
    where challenge_id = p_challenge_id and user_id = auth.uid()
      and status in ('pending', 'active');

    perform finalize_challenge_if_done(p_challenge_id);
  end if;
end;
$function$;

-- ---------------------------------------------------------------- guard
-- hide_challenge_from_history is a pure PER-USER cosmetic hide (see
-- migrations_duel_history_swipe_delete.sql) -- it must never be the way a
-- still-active duel gets "deleted," or bug 2 recurs regardless of what the
-- client does: cancel_challenge/forfeit_challenge above are the only
-- correct exits for a live challenge. Server-side guardrail, not just a
-- client convention, so a stray/future call can't quietly desync the
-- other participant(s) again.
create or replace function public.hide_challenge_from_history(p_challenge_id uuid)
 returns void
 language plpgsql
 security definer
as $function$
begin
  if exists (select 1 from challenges c where c.id = p_challenge_id and c.status = 'active') then
    raise exception 'This duel is still active -- cancel or forfeit it, not delete it from history';
  end if;

  update challenge_participants
  set hidden_at = now()
  where challenge_id = p_challenge_id and user_id = auth.uid();

  if not found then
    raise exception 'Not a participant in this duel';
  end if;
end;
$function$;

-- ---------------------------------------------------------------- standings
-- Same tier-sort as finalize above (active always outranks forfeited),
-- widened from status='active' only so a forfeiter still shows up in their
-- own results screen instead of silently vanishing from standings. Adds
-- is_forfeited so the UI can label that row instead of implying they lost
-- on merit.
--
-- Adding an output column changes the function's row type, which Postgres
-- won't let CREATE OR REPLACE do in place (same gotcha already documented
-- in migrations_add_leaderboard_avatar_visibility.sql) -- drop first.
drop function if exists public.get_challenge_standings(uuid);
create or replace function public.get_challenge_standings(p_challenge_id uuid)
 returns table(user_id uuid, label text, is_me boolean, correct_count integer,
              tiebreak_ms integer, final_rank integer, tie_group_size integer, is_forfeited boolean)
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
  with scored_participants as (
    select cp.user_id, cp.status from challenge_participants cp
    where cp.challenge_id = p_challenge_id and cp.status in ('active', 'forfeited')
  ),
  correct_counts as (
    select sp.user_id, sp.status,
      (select count(*)::int from challenge_answers ca join challenge_questions cq on cq.id = ca.challenge_question_id
         where cq.challenge_id = p_challenge_id and ca.user_id = sp.user_id and ca.is_correct) as correct_count
    from scored_participants sp
  ),
  qualifying_questions as (
    select cc1.user_id, cq.id as question_id
    from correct_counts cc1
    cross join challenge_questions cq
    where cq.challenge_id = p_challenge_id
    and not exists (
      select 1 from correct_counts cc2
      where cc2.correct_count = cc1.correct_count and cc2.status = cc1.status
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
      coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)) as label,
      cc.user_id = auth.uid() as is_me,
      cc.correct_count,
      coalesce(tt.tiebreak_ms, 0) as tiebreak_ms,
      rank() over (
        order by (case when cc.status = 'forfeited' then 1 else 0 end),
                 cc.correct_count desc, coalesce(tt.tiebreak_ms, 0) asc
      )::int as final_rank,
      count(*) over (
        partition by (case when cc.status = 'forfeited' then 1 else 0 end), cc.correct_count, coalesce(tt.tiebreak_ms, 0)
      )::int as tie_group_size,
      cc.status = 'forfeited' as is_forfeited
    from correct_counts cc
    join auth.users u on u.id = cc.user_id
    left join callsign_registry cr on cr.user_id = cc.user_id
    left join tiebreak_times tt on tt.user_id = cc.user_id
  )
  select r.user_id, r.label, r.is_me, r.correct_count, r.tiebreak_ms, r.final_rank, r.tie_group_size, r.is_forfeited
  from ranked r
  where v_completed or r.is_me
  order by r.final_rank, r.label;
end;
$function$;

-- ---------------------------------------------------------------- next-q
-- Live-caught by this migration's own verification script (scenario:
-- creator cancels while the opponent is mid-duel): get_next_challenge_
-- question never checked challenges.status at all -- only the caller's own
-- challenge_participants.status='active'. submit_challenge_answer already
-- correctly rejects a cancelled challenge (`c.status = 'active'` in its own
-- join), so the previous behavior was "the app happily serves you question
-- 3 of a duel that no longer exists, then only discovers that the instant
-- you tap an answer" -- exactly the residual half of bug 2 RC described
-- ("the play/answer screen itself refusing to let them proceed if the
-- underlying challenge was cancelled after they navigated in"). Same
-- `c.status = 'active'` guard submit_challenge_answer already has.
CREATE OR REPLACE FUNCTION public.get_next_challenge_question(p_challenge_id uuid)
 RETURNS TABLE(question_id uuid, sort_order integer, item_type text, prompt text, choices text[], already_answered boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  return query
  select cq.id, cq.sort_order, cq.item_type,
    coalesce(
      cq.question,  -- real authored question, denormalized at creation time
      case cq.item_type
        when 'pcg' then (select quiz_prompt_condense(pt.definition) from pcg_terms pt where pt.term = cq.item_id limit 1)
        when 'far' then (select regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') from far_sections f where f.section_number = cq.item_id)
        when 'aim' then (select a.title from aim_paragraphs a where a.paragraph_number = cq.item_id)
        when 'ac' then (select c.title from advisory_circulars c where c.document_number = cq.item_id)
        when 'dictionary' then (
          select case when public.has_pro_access() then quiz_prompt_condense(d.senses->0->>'definition') else d.term end
          from dictionary_terms d where d.slug = cq.item_id
        )
      end
    ),
    cq.choices,
    exists (select 1 from challenge_answers ca where ca.challenge_question_id = cq.id and ca.user_id = auth.uid())
  from challenge_questions cq
  join challenges c on c.id = cq.challenge_id
  where cq.challenge_id = p_challenge_id
    and c.status = 'active'
    and exists (select 1 from challenge_participants cp where cp.challenge_id = cq.challenge_id and cp.user_id = auth.uid() and cp.status = 'active')
    and not exists (select 1 from challenge_answers ca where ca.challenge_question_id = cq.id and ca.user_id = auth.uid())
  order by cq.sort_order
  limit 1;
end;
$function$;

-- ---------------------------------------------------------------- results
-- Widened from status='active' only, same reasoning as get_challenge_
-- standings above -- a forfeiter's own already-submitted answers stay
-- visible in the per-question breakdown instead of vanishing.
CREATE OR REPLACE FUNCTION public.get_challenge_results(p_challenge_id uuid)
 RETURNS TABLE(sort_order integer, item_type text, item_id text, term text, definition text, answers jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
    cq.sort_order, cq.item_type, cq.item_id,
    case cq.item_type
      when 'pcg' then (select pt.term from pcg_terms pt where pt.term = cq.item_id limit 1)
      when 'dictionary' then (select d.term from dictionary_terms d where d.slug = cq.item_id)
      else cq.item_id
    end,
    case cq.item_type
      when 'pcg' then (select pt.definition from pcg_terms pt where pt.term = cq.item_id limit 1)
      when 'far' then (select f.title from far_sections f where f.section_number = cq.item_id)
      when 'aim' then (select a.title from aim_paragraphs a where a.paragraph_number = cq.item_id)
      when 'ac' then (select c.title from advisory_circulars c where c.document_number = cq.item_id)
      when 'dictionary' then (
        select case when public.has_pro_access() then d.senses->0->>'definition' else null end
        from dictionary_terms d where d.slug = cq.item_id
      )
    end,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', cp.user_id,
        'label', coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
        'isMe', cp.user_id = auth.uid(),
        'isForfeited', cp.status = 'forfeited',
        'answerText', case when v_completed or cp.user_id = auth.uid() then ca.answer_text else null end,
        'isCorrect',  case when v_completed or cp.user_id = auth.uid() then ca.is_correct else null end,
        'timeMs',     case when v_completed or cp.user_id = auth.uid() then ca.time_ms else null end
      ) order by cp.is_creator desc, u.email), '[]'::jsonb)
      from challenge_participants cp
      join auth.users u on u.id = cp.user_id
      left join callsign_registry cr on cr.user_id = cp.user_id
      left join challenge_answers ca on ca.challenge_question_id = cq.id and ca.user_id = cp.user_id
      where cp.challenge_id = p_challenge_id and cp.status in ('active', 'forfeited')
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
