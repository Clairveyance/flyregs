-- Found 2026-08-19/20, full gating re-sweep, while checking every function
-- that touches a paid-content column for a has_plus_access()/has_pro_access()
-- gate. get_next_challenge_question() and get_challenge_results() (Duels
-- gameplay) both fall back to a LIVE, ungated query against the raw
-- dictionary_terms.senses column whenever a challenge_questions row has no
-- denormalized cq.question/cq.correct_answer (the normal path when a real
-- study_facts row exists at creation time) -- and that fallback fires for
-- every 'dictionary'-type question in the live DB today (3/3 rows have
-- question IS NULL, confirmed via `select item_type, count(*) filter (where
-- question is null) ... group by item_type`; several other item_types are
-- null-heavy too, e.g. 15/15 pcg, but pcg/far/aim/ac all fall back to
-- ALREADY-FREE content -- pcg_terms.definition, far_sections/aim_paragraphs/
-- advisory_circulars TITLES only, never body_text/pdf_blocks -- so only the
-- dictionary branch is a real gate gap).
--
-- Why this is reachable by someone who shouldn't have it, even though
-- create_challenge() requires Premium at the door and respond_to_challenge()
-- requires Premium to Accept: gameplay RPCs are DELIBERATELY left open for a
-- participant whose Premium lapses mid-duel (gotcha_entitlement_check_never_
-- continuous.md / gotcha_gating_sweep_2026_08_14.md -- blocking gameplay
-- itself risks permanently stranding the OPPONENT's duel, since
-- finalize_challenge_if_done never completes while anyone can't submit).
-- That design correctly protects the ABILITY TO ANSWER, but this function
-- was also handing back a live, un-redacted read of a Pro-gated content
-- column (dictionary mnemonic senses) on every call, for a caller who may
-- have dropped below Pro (not just below Premium) since accepting -- a
-- materially different thing than "let them keep playing."
--
-- Fix: gate ONLY the dictionary-senses lookup on has_pro_access(), same
-- redaction shape as dictionary_terms_gated's own view. Falls back to the
-- bare term (free/public metadata -- visible in any un-gated browse list)
-- rather than erroring or returning null, so gameplay still proceeds
-- uninterrupted for a lapsed participant -- it just stops handing them
-- fresh paid mnemonic text while they're not entitled to it. Does not
-- change behavior at all for the overwhelmingly common case (a genuinely
-- Premium participant, who has Pro access by the superset ladder anyway).

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
  where cq.challenge_id = p_challenge_id
    and exists (select 1 from challenge_participants cp where cp.challenge_id = cq.challenge_id and cp.user_id = auth.uid() and cp.status = 'active')
    and not exists (select 1 from challenge_answers ca where ca.challenge_question_id = cq.id and ca.user_id = auth.uid())
  order by cq.sort_order
  limit 1;
end;
$function$;

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
        'answerText', case when v_completed or cp.user_id = auth.uid() then ca.answer_text else null end,
        'isCorrect',  case when v_completed or cp.user_id = auth.uid() then ca.is_correct else null end,
        'timeMs',     case when v_completed or cp.user_id = auth.uid() then ca.time_ms else null end
      ) order by cp.is_creator desc, u.email), '[]'::jsonb)
      from challenge_participants cp
      join auth.users u on u.id = cp.user_id
      left join callsign_registry cr on cr.user_id = cp.user_id
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
