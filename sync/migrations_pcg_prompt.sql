-- ============================================================================
-- P/CG duel prompts: condense the glossary definition  --  2026-07-31
--
-- A P/CG duel shows a definition and asks which term it defines. It served
-- the definition VERBATIM, and the glossary is not written for that:
--     786 quizzable terms, average definition 205 chars, longest 1,426
--     446 of 786 (57%) over 140 chars
-- Observed in a real played duel: a 311-character prompt beginning
-- "Any locality either on land, water, or structures, including
-- airports/heliports and intermediate landing fields...". That is a wall of
-- text, not a game-show question.
--
-- The FAA writes these definitions with the defining clause FIRST and the
-- qualifications after, so the opening sentence is both the shortest and the
-- most identifying part. Cut to the first sentence, then hard-cap at a word
-- boundary with an ellipsis so nothing runs long. The answer stays
-- unambiguous because it is multiple choice against 5 other terms.
-- ============================================================================

create or replace function public.quiz_prompt_condense(p_text text, p_max int default 180)
returns text
language sql
immutable
as $function$
  with cleaned as (
    select btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')) as t
  ),
  first_sentence as (
    select t,
      -- First sentence ending in ". " within the cap. Requires 20+ chars so a
      -- leading abbreviation ("U.S. ") can't produce a two-word prompt.
      coalesce(substring(t from '^.{20,' || p_max || '}?[.](?:\s|$)'), t) as s
    from cleaned
  )
  select case
    when length(s) <= p_max then btrim(s)
    -- Still too long: cut at the last space that fits and mark the elision.
    else btrim(left(s, p_max - length(regexp_replace(left(s, p_max), '^.*\s', '')))) || '…'
  end
  from first_sentence;
$function$;

grant execute on function public.quiz_prompt_condense(text, int) to anon, authenticated;

-- Duel question prompt: P/CG now condensed. FAR/AIM/AC prompts are titles and
-- were already short.
create or replace function public.get_next_challenge_question(p_challenge_id uuid)
returns table(question_id uuid, sort_order integer, item_type text, prompt text,
              choices text[], already_answered boolean)
language plpgsql
security definer
as $function$
begin
  return query
  select cq.id, cq.sort_order, cq.item_type,
    case cq.item_type
      when 'pcg' then (select quiz_prompt_condense(pt.definition) from pcg_terms pt where pt.term = cq.item_id limit 1)
      when 'far' then (select regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', '') from far_sections f where f.section_number = cq.item_id)
      when 'aim' then (select a.title from aim_paragraphs a where a.paragraph_number = cq.item_id)
      when 'ac' then (select c.title from advisory_circulars c where c.document_number = cq.item_id)
    end,
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
