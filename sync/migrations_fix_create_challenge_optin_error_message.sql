-- 2026-08-15, B33-readiness regression sweep: create_challenge's leaderboard
-- opt-in check (migrations_create_challenge_optin_check.sql) is correct and
-- deliberate -- it's the SAME consent flag (user_streaks.leaderboard_opt_in)
-- that Find Friends contact-match already respects (see
-- migrations_contact_match.sql's own comment: "gated by the SAME
-- leaderboard_opt_in flag Duels discoverability already uses... consistent
-- with the one [privacy model]") -- so this is NOT being relaxed.
--
-- The real bug: today's new Duels "Add by Callsign" flow
-- (challenges/index.tsx, lookup_user_by_callsign) resolves an EXACT
-- callsign to a real user with no opt-in check at all -- unlike Find
-- Friends contact-match, which only ever surfaces opted-in people to begin
-- with, callsign search can find and let you add someone who then silently
-- fails at Start Duel with a generic "one or more selected opponents are
-- not available to challenge" that names no one. Live-reproduced by the
-- audit agent: a callsign-searched user with no user_streaks row broke
-- creation with zero indication of who or why.
--
-- Fix: name the specific callsign(s) in the error. The client already
-- surfaces create_challenge's error message inline in the sheet
-- (challenges/index.tsx's handleStartDuel -- "the only failure a player can
-- actually act on... shown inline, not Alert.alert"), so this alone turns
-- an opaque dead-end into an actionable one with no client changes needed.
-- Same signature -> safe CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.create_challenge(p_opponent_ids uuid[], p_question_count integer DEFAULT 5, p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_challenge_id uuid;
  v_item record;
  v_fact record;
  v_have_fact boolean;
  v_i int := 0;
  v_choices text[];
  v_opp uuid;
  v_used_fact_ids uuid[] := array[]::uuid[];
  v_unavailable_callsigns text;
begin
  if not exists (select 1 from user_entitlements ue where ue.user_id = auth.uid() and ue.is_premium = true) then
    raise exception 'Duels requires Premium';
  end if;

  if array_length(p_opponent_ids, 1) is null or array_length(p_opponent_ids, 1) < 1 then
    raise exception 'At least one opponent required';
  end if;
  if array_length(p_opponent_ids, 1) > 7 then
    raise exception 'Duels support up to 8 total participants';
  end if;
  if auth.uid() = any(p_opponent_ids) then
    raise exception 'Cannot challenge yourself';
  end if;

  select string_agg(coalesce(cr.callsign, 'That pilot'), ', ')
  into v_unavailable_callsigns
  from unnest(p_opponent_ids) opp_id
  left join callsign_registry cr on cr.user_id = opp_id
  where not exists (
    select 1 from user_streaks us where us.user_id = opp_id and us.leaderboard_opt_in = true
  );
  if v_unavailable_callsigns is not null then
    raise exception '% hasn''t enabled Duel challenges yet. Remove them to continue.', v_unavailable_callsigns;
  end if;

  -- `ratings` column intentionally left null -- rating selections now live
  -- in `levels` alongside cert-level values (see this migration's header).
  insert into challenges (challenger_id, status, question_count, item_types, levels, category_classes)
  values (auth.uid(), 'active', p_question_count, p_item_types, p_levels, p_category_classes)
  returning id into v_challenge_id;

  insert into challenge_participants (challenge_id, user_id, is_creator, status, responded_at)
  values (v_challenge_id, auth.uid(), true, 'active', now());

  foreach v_opp in array p_opponent_ids loop
    insert into challenge_participants (challenge_id, user_id, is_creator, status)
    values (v_challenge_id, v_opp, false, 'pending')
    on conflict (challenge_id, user_id) do nothing;
  end loop;

  for v_item in
    select * from (
      select item_type, item_id from (
        select 'pcg' as item_type, term as item_id
        from quizzable_pcg_terms
        where (p_levels is null or pcg_all_levels(slug, term) && p_levels)
          and (p_category_classes is null or category_classes_from_text(term) is null or category_classes_from_text(term) && p_category_classes)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'pcg' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'far' as item_type, section_number as item_id
        from quizzable_far_sections f2
        where not (far_knowledge_levels(f2.part, f2.subpart_letter) && array['not_applicable'])
          and (p_levels is null or far_all_levels(f2.part, f2.subpart_letter, f2.section_number) && p_levels)
          and (p_category_classes is null or far_category_classes(f2.part, f2.title) is null or far_category_classes(f2.part, f2.title) && p_category_classes)
        order by (far_relevance_weight(f2.part) + 1) * random() desc limit p_question_count * 3
      ) x
      where p_item_types is null or 'far' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'aim' as item_type, paragraph_number as item_id
        from quizzable_aim_paragraphs
        where (p_levels is null or aim_all_levels(chapter, paragraph_number) && p_levels)
          and (p_category_classes is null or aim_category_classes(chapter, coalesce(title, '')) is null or aim_category_classes(chapter, coalesce(title, '')) && p_category_classes)
        order by random() limit p_question_count * 3
      ) x
      where p_item_types is null or 'aim' = any(p_item_types)
      union all
      select item_type, item_id from (
        select 'ac' as item_type, document_number as item_id
        from quizzable_advisory_circulars c2
        where not (ac_knowledge_levels(c2.subject_series) && array['not_applicable'])
          and (p_levels is null or ac_all_levels(c2.subject_series) && p_levels)
          and (p_category_classes is null or ac_category_classes(c2.subject_series, c2.title) is null or ac_category_classes(c2.subject_series, c2.title) && p_category_classes)
        order by (ac_relevance_weight(c2.document_number) + 1) * random() desc limit p_question_count
      ) x
      where p_item_types is null or 'ac' = any(p_item_types)
    ) pool
    order by random() limit p_question_count
  loop
    v_have_fact := false;
    if v_item.item_type in ('far', 'aim', 'ac') then
      select sf.* into v_fact
      from study_facts sf
      where sf.item_type = v_item.item_type
        and sf.item_id = v_item.item_id
        and sf.status = 'live'
        and sf.distractors is not null
        and array_length(sf.distractors, 1) = 3
        and not (sf.id = any(v_used_fact_ids))
      order by random()
      limit 1;
      v_have_fact := found;
    end if;

    if v_have_fact then
      v_used_fact_ids := array_append(v_used_fact_ids, v_fact.id);
      select array_agg(c order by random()) into v_choices
      from unnest(array_cat(array[v_fact.answer], v_fact.distractors)) c;

      insert into challenge_questions (challenge_id, sort_order, item_type, item_id, choices, fact_id, question, correct_answer)
      values (v_challenge_id, v_i, v_item.item_type, v_item.item_id, v_choices, v_fact.id, v_fact.question, v_fact.answer);
      v_i := v_i + 1;
      continue;
    end if;

    case v_item.item_type
      when 'pcg' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.term), array[]::text[]))
        into v_choices
        from (select term from pcg_terms where definition is not null and definition <> '' and term is not null and (p_levels is null or pcg_all_levels(slug, term) && p_levels) and term <> v_item.item_id order by random() limit 5) t;
      when 'far' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.section_number), array[]::text[]))
        into v_choices
        from (select section_number from far_sections f3 where f3.title is not null and f3.title <> ''
              and not (far_knowledge_levels(f3.part, f3.subpart_letter) && array['not_applicable'])
              and (p_levels is null or far_all_levels(f3.part, f3.subpart_letter, f3.section_number) && p_levels)
              and f3.section_number <> v_item.item_id order by random() limit 5) t;
      when 'aim' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.paragraph_number), array[]::text[]))
        into v_choices
        from (select paragraph_number from aim_paragraphs where title is not null and title <> '' and (p_levels is null or aim_all_levels(chapter, paragraph_number) && p_levels) and paragraph_number <> v_item.item_id order by random() limit 5) t;
      when 'ac' then
        select array_cat(array[v_item.item_id], coalesce(array_agg(t.document_number), array[]::text[]))
        into v_choices
        from (select document_number from advisory_circulars c3 where c3.status = 'active' and c3.description is not null and c3.description <> '' and c3.title is not null and c3.title <> ''
              and not (ac_knowledge_levels(c3.subject_series) && array['not_applicable'])
              and (p_levels is null or ac_all_levels(c3.subject_series) && p_levels)
              and c3.document_number <> v_item.item_id order by random() limit 5) t;
    end case;

    select array_agg(c order by random()) into v_choices from unnest(v_choices) c;

    insert into challenge_questions (challenge_id, sort_order, item_type, item_id, choices)
    values (v_challenge_id, v_i, v_item.item_type, v_item.item_id, v_choices);
    v_i := v_i + 1;
  end loop;

  if v_i = 0 then
    raise exception 'No questions match those filters. Try widening the Content or Knowledge Level selection.';
  end if;

  if v_i <> p_question_count then
    update challenges set question_count = v_i where id = v_challenge_id;
  end if;

  return v_challenge_id;
end;
$function$;
