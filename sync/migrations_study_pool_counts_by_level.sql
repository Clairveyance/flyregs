-- Per-level pool counts in ONE pass (2026-09-01)
--
-- RC: "we essentially need a system that has one large bank with several
-- sections - so, Ex: section 1 is Student and it has 713 student Qs; section 2
-- is Private and it has 425 Qs... then just pick/choose which boxes you want."
--
-- That is what the filters already do, but the UI only ever showed ONE
-- aggregate line ("N items match the filters above"), so the sections were
-- invisible -- there was no way to see that Instrument held 79 items while
-- Private held 1,171, which is exactly the kind of hole that hid the empty
-- Dictionary box for so long.
--
-- Doing this client-side would mean 9 calls to get_study_pool_count, measured
-- at 297-488ms each = ~4.4s on mount. This computes every level in a single
-- scan instead: each item contributes one row per level it carries, then one
-- GROUP BY. Item-type and category filters still apply, so the counts always
-- reflect the OTHER chips the user has already set.
--
-- Conditions below are copied verbatim from get_study_pool_count so the two
-- can never disagree -- if that function's eligibility rules change, this one
-- must change with it.

begin;

create or replace function public.get_study_pool_counts_by_level(
  p_item_types text[] default null,
  p_category_classes text[] default null
)
returns table(level text, cnt bigint)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select s.lv as level, count(*)::bigint as cnt
  from (
    select unnest(pcg_all_levels(p.slug, p.term)) as lv
      from pcg_terms p
     where (p_item_types IS NULL OR 'pcg' = ANY(p_item_types))
       and p.definition IS NOT NULL AND p.definition <> ''
       and (p_category_classes IS NULL OR category_classes_from_text(p.term) IS NULL OR category_classes_from_text(p.term) && p_category_classes)
    union all
    select unnest(far_all_levels(f.part, f.subpart_letter, f.section_number))
      from far_sections f
     where (p_item_types IS NULL OR 'far' = ANY(p_item_types))
       and f.body_text IS NOT NULL AND f.body_text <> ''
       and f.title IS NOT NULL AND f.title <> ''
       and f.section_number IN (SELECT section_number FROM study_far_sections)
       and NOT (far_knowledge_levels(f.part, f.subpart_letter) && ARRAY['not_applicable'])
       and (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes)
    union all
    select unnest(aim_all_levels(a.chapter, a.paragraph_number))
      from aim_paragraphs a
     where (p_item_types IS NULL OR 'aim' = ANY(p_item_types))
       and a.body_text IS NOT NULL AND a.body_text <> ''
       and (p_category_classes IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title,'')) IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title,'')) && p_category_classes)
    union all
    select unnest(ac_all_levels(c.subject_series, c.document_number))
      from advisory_circulars c
     where (p_item_types IS NULL OR 'ac' = ANY(p_item_types))
       and c.status = 'active' AND c.description IS NOT NULL AND c.description <> ''
       and c.title IS NOT NULL AND c.title <> ''
       and NOT (ac_knowledge_levels(c.subject_series) && ARRAY['not_applicable'])
       and (p_category_classes IS NULL OR ac_category_classes(c.subject_series, c.title) IS NULL OR ac_category_classes(c.subject_series, c.title) && p_category_classes)
    union all
    select unnest(dictionary_all_levels(d.slug))
      from dictionary_terms d
     where (p_item_types IS NULL OR 'dictionary' = ANY(p_item_types))
       and d.category IN ('handbook', 'mnemonic')
       and d.senses->0->>'definition' IS NOT NULL AND d.senses->0->>'definition' <> ''
       and (p_category_classes IS NULL OR dictionary_category_classes(d.slug) IS NULL OR dictionary_category_classes(d.slug) && p_category_classes)
    union all
    select unnest(cfr49_all_levels(f5.part, f5.section_number))
      from cfr49_sections f5
     where (p_item_types IS NULL OR 'cfr49' = ANY(p_item_types))
       and f5.body_text IS NOT NULL AND f5.body_text <> ''
       and f5.title IS NOT NULL AND f5.title <> ''
       and NOT (cfr49_knowledge_levels(f5.part) && ARRAY['not_applicable'])
       and (p_category_classes IS NULL OR cfr49_category_classes(f5.part, f5.title) IS NULL OR cfr49_category_classes(f5.part, f5.title) && p_category_classes)
  ) s(lv)
  where public.has_pro_access()
  group by s.lv;
$function$;

revoke execute on function public.get_study_pool_counts_by_level(text[], text[]) from public, anon;
grant execute on function public.get_study_pool_counts_by_level(text[], text[]) to authenticated;

commit;
