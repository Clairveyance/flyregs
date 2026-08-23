-- Found 2026-08-23, careful pre-B35 QA sweep. Same bug class the 2026-08-19/20
-- fix (migrations_fix_duel_dictionary_mnemonic_leak.sql) closed for the
-- dictionary branch, but missed for 'ac': that fix's own comment reasoned
-- 'ac' was safe because its NULL-question FALLBACK only ever returns
-- advisory_circulars.title (free/public metadata) -- true, and still true
-- here. What it didn't account for: when a challenge_questions row DOES have
-- a denormalized cq.question (the normal path, whenever a matching
-- study_facts row existed at creation time), COALESCE returns that raw value
-- immediately and never evaluates the fallback CASE at all -- for ANY
-- item_type, unconditionally. 2,105 real 'ac'-type study_facts rows exist
-- today, and ac/[id].tsx's own comment states plainly that "AC full text...
-- Plus (hasPlusAccess)" -- so a denormalized 'ac' question can genuinely
-- carry real, gated AC body content, with zero check that the CURRENT
-- reader (not the duel creator at authoring time) still has Plus access.
--
-- Live-reproduced for the sibling 'dictionary' case in this same sweep
-- (a Premium-at-accept participant downgraded to Free mid-duel still
-- received a full real Pro-gated mnemonic quiz question) -- the 'ac' case
-- shares the identical mechanism and data precondition but wasn't
-- separately live-exploited before this fix; treating it as confirmed by
-- code+data shape, not just theoretical.
--
-- Fix: nullify cq.question up front for any item_type whose underlying
-- content is tier-gated (dictionary -> has_pro_access, ac -> has_plus_access)
-- when the CURRENT caller doesn't have that access, before the outer
-- COALESCE runs -- forcing a fall-through to the same safe, already-free
-- fallback (bare term / bare title) either function already uses for the
-- "no denormalized question" case. pcg/far/aim are untouched: confirmed
-- their content is readable at zero tier (only actions like print/share/
-- highlight are gated, never the text itself), so no equivalent gap exists
-- for those item_types regardless of whether cq.question is populated.

CREATE OR REPLACE FUNCTION public.get_next_challenge_question(p_challenge_id uuid)
 RETURNS TABLE(question_id uuid, sort_order integer, item_type text, prompt text, choices text[], already_answered boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  return query
  select cq.id, cq.sort_order, cq.item_type,
    coalesce(
      case
        when cq.item_type = 'dictionary' and not public.has_pro_access() then null
        when cq.item_type = 'ac' and not public.has_plus_access() then null
        else cq.question
      end,
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
