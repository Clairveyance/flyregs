-- Gating sweep 2026-08-11 (RC: "you just found more gating issues... set up
-- another detailed pass across the entire app"). 5 parallel agents audited
-- every row of the Tier Placement Matrix with live disposable accounts,
-- not the ?tier= client preview stub. This batch covers every finding with
-- a mechanical "add a has_plus_access()/has_pro_access() guard" shape;
-- the smaller number of findings needing a bespoke design (raw-table
-- aircraft-cap bypass, document_citations count-vs-tap-through split,
-- inline cross-reference link tap-through) are handled in a separate pass.

-- Advanced Filter system (Plus) -- zero gate existed anywhere: not in the
-- client's openFilter() entry point, not in this RPC. Confirmed live,
-- fully anonymous: filter_documents({"p_content_types":["loi"]}) returned
-- real LOI titles+snippets. The filter TOOL itself is the Plus-gated
-- capability (distinct from "AC/LOI title+snippet in search," which is
-- separately free per the matrix and unaffected by this change) -- so this
-- blocks the whole function for non-Plus regardless of which content
-- types are requested, rather than trying to filter per-type.
CREATE OR REPLACE FUNCTION public.filter_documents(p_content_types text[] DEFAULT NULL::text[], p_far_parts text[] DEFAULT NULL::text[], p_ac_series text DEFAULT NULL::text, p_audience text[] DEFAULT NULL::text[], p_cites_type text DEFAULT NULL::text, p_cites_id text DEFAULT NULL::text, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_has_figures boolean DEFAULT NULL::boolean, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(item_type text, item_id text, primary_label text, secondary_label text, total_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH matched AS (
    SELECT 'far' AS item_type, f.section_number AS item_id,
      '§ ' || f.section_number || ' ' || COALESCE(regexp_replace(f.title, '^§\s*[0-9]+(\.[0-9]+)?\s*', ''), '') AS primary_label,
      left(f.body_text, 160) AS secondary_label
    FROM far_sections f
    WHERE (p_content_types IS NULL OR 'far' = ANY(p_content_types))
      AND (p_far_parts IS NULL OR f.part = ANY(p_far_parts))
      AND (p_date_from IS NULL OR f.last_amended >= p_date_from)
      AND (p_date_to IS NULL OR f.last_amended <= p_date_to)
      AND (p_has_figures IS NOT TRUE OR f.body_text LIKE '%|%|%|%')
      AND (p_cites_type IS NULL OR EXISTS (
        SELECT 1 FROM document_citations dc
        WHERE dc.citing_type = 'far' AND dc.citing_id = f.section_number
          AND dc.cited_type = p_cites_type AND dc.cited_id = p_cites_id
      ))

    UNION ALL
    SELECT 'aim', a.paragraph_number,
      a.paragraph_number || COALESCE(' ' || a.title, ''),
      left(a.body_text, 160)
    FROM aim_paragraphs a
    WHERE (p_content_types IS NULL OR 'aim' = ANY(p_content_types))
      AND (p_date_from IS NULL OR a.updated_at::date >= p_date_from)
      AND (p_date_to IS NULL OR a.updated_at::date <= p_date_to)
      AND (p_has_figures IS NOT TRUE OR EXISTS (SELECT 1 FROM aim_figures af WHERE af.paragraph_number = a.paragraph_number))
      AND (p_cites_type IS NULL OR EXISTS (
        SELECT 1 FROM document_citations dc
        WHERE dc.citing_type = 'aim' AND dc.citing_id = a.paragraph_number
          AND dc.cited_type = p_cites_type AND dc.cited_id = p_cites_id
      ))

    UNION ALL
    SELECT 'pcg', p.slug, p.term, left(p.definition, 160)
    FROM pcg_terms p
    WHERE (p_content_types IS NULL OR 'pcg' = ANY(p_content_types))
      AND (p_date_from IS NULL OR p.updated_at::date >= p_date_from)
      AND (p_date_to IS NULL OR p.updated_at::date <= p_date_to)
      AND (p_has_figures IS NOT TRUE)
      AND (p_cites_type IS NULL OR EXISTS (
        SELECT 1 FROM document_citations dc
        WHERE dc.citing_type = 'pcg' AND dc.citing_id = p.slug
          AND dc.cited_type = p_cites_type AND dc.cited_id = p_cites_id
      ))

    UNION ALL
    SELECT 'ac', c.document_number, 'AC ' || c.document_number || ': ' || c.title, left(c.description, 160)
    FROM advisory_circulars c
    LEFT JOIN ac_series s ON s.series_prefix = c.subject_series
    WHERE (p_content_types IS NULL OR 'ac' = ANY(p_content_types))
      AND c.status = 'active'
      AND (p_ac_series IS NULL OR c.subject_series = p_ac_series)
      AND (p_audience IS NULL OR s.audience && p_audience)
      AND (p_date_from IS NULL OR c.date_issued >= p_date_from)
      AND (p_date_to IS NULL OR c.date_issued <= p_date_to)
      AND (p_has_figures IS NOT TRUE OR EXISTS (SELECT 1 FROM ac_figures af WHERE af.ac_id = c.id))
      AND (p_cites_type IS NULL OR EXISTS (
        SELECT 1 FROM document_citations dc
        WHERE dc.citing_type = 'ac' AND dc.citing_id = c.document_number
          AND dc.cited_type = p_cites_type AND dc.cited_id = p_cites_id
      ))

    UNION ALL
    SELECT 'loi', l.slug, l.title, left(l.summary, 160)
    FROM legal_interpretations l
    WHERE (p_content_types IS NULL OR 'loi' = ANY(p_content_types))
      AND (p_date_from IS NULL OR l.issued_date >= p_date_from)
      AND (p_date_to IS NULL OR l.issued_date <= p_date_to)
      AND (p_has_figures IS NOT TRUE OR l.body_text LIKE '%|%|%|%')
      AND (p_cites_type IS NULL OR EXISTS (
        SELECT 1 FROM document_citations dc
        WHERE dc.citing_type = 'loi' AND dc.citing_id = l.slug
          AND dc.cited_type = p_cites_type AND dc.cited_id = p_cites_id
      ))
  )
  SELECT item_type, item_id, primary_label, secondary_label, count(*) OVER() AS total_count
  FROM matched
  WHERE public.has_plus_access()
  ORDER BY item_type, item_id
  LIMIT p_limit OFFSET p_offset;
$function$;

-- DailyReg (Pro) -- fully anonymous request returned real content, no
-- differentiation by tier at all. Client only gated the RENDER
-- (DailyRegCard's `if (!isPro)`), never the fetch.
CREATE OR REPLACE FUNCTION public.get_reg_of_the_day(for_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(slug text, term text, definition text, source_type text)
 LANGUAGE sql
 STABLE
AS $function$
  with pool as (
    select item_id as slug, question as term, answer as definition, item_type as source_type
    from study_facts
    where item_type in ('far', 'aim')
      and status = 'live'
      and question is not null and question <> ''
      and answer is not null and answer <> ''
    union all
    select document_number as slug, title as term,
           (description || ' · ' || document_number) as definition,
           'ac' as source_type
    from advisory_circulars
    where status = 'active'
      and title is not null and title <> ''
      and description is not null and description <> ''
  ),
  ordered as (
    select *, row_number() over (order by source_type, slug) - 1 as idx, count(*) over () as total
    from pool
  )
  select slug, term, definition, source_type from ordered
  where idx = (abs(hashtext(for_date::text)) % total)
    and public.has_pro_access();
$function$;

-- Study Mode (Pro) -- comprehensive: none of the 5 RPCs behind this
-- feature had any tier check; a Free account could read full Q&A content
-- AND fully play the feature (record_study_review), earning real
-- achievement coins later shown on the public Nametag/Profile.
CREATE OR REPLACE FUNCTION public.get_study_pool_count(p_item_types text[] DEFAULT NULL::text[], p_levels text[] DEFAULT NULL::text[], p_category_classes text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT CASE WHEN NOT public.has_pro_access() THEN 0 ELSE
    (SELECT count(*) FROM pcg_terms p
       WHERE (p_item_types IS NULL OR 'pcg' = ANY(p_item_types))
         AND (p_levels IS NULL OR pcg_knowledge_levels(p.slug) && p_levels)
         AND p.definition IS NOT NULL AND p.definition <> ''
         AND (p_category_classes IS NULL OR category_classes_from_text(p.term) IS NULL OR category_classes_from_text(p.term) && p_category_classes)
         AND (p_ratings IS NULL OR pcg_ratings(p.term) IS NULL OR pcg_ratings(p.term) && p_ratings))
  + (SELECT count(*) FROM far_sections f
       WHERE (p_item_types IS NULL OR 'far' = ANY(p_item_types))
         AND f.body_text IS NOT NULL AND f.body_text <> ''
         AND f.title IS NOT NULL AND f.title <> ''
         AND f.section_number IN (SELECT section_number FROM study_far_sections)
         AND (p_levels IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) IS NULL OR far_knowledge_levels(f.part, f.subpart_letter) && p_levels)
         AND (p_category_classes IS NULL OR far_category_classes(f.part, f.title) IS NULL OR far_category_classes(f.part, f.title) && p_category_classes)
         AND (p_ratings IS NULL OR far_ratings(f.part, f.section_number) IS NULL OR far_ratings(f.part, f.section_number) && p_ratings))
  + (SELECT count(*) FROM aim_paragraphs a
       WHERE (p_item_types IS NULL OR 'aim' = ANY(p_item_types))
         AND (p_levels IS NULL OR aim_knowledge_levels(a.chapter, a.paragraph_number) && p_levels)
         AND a.body_text IS NOT NULL AND a.body_text <> ''
         AND (p_category_classes IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) IS NULL OR aim_category_classes(a.chapter, COALESCE(a.title, '')) && p_category_classes)
         AND (p_ratings IS NULL OR aim_ratings(a.chapter, a.paragraph_number) IS NULL OR aim_ratings(a.chapter, a.paragraph_number) && p_ratings))
  + (SELECT count(*) FROM advisory_circulars c
       WHERE (p_item_types IS NULL OR 'ac' = ANY(p_item_types))
         AND c.status = 'active' AND c.description IS NOT NULL AND c.description <> ''
         AND c.title IS NOT NULL AND c.title <> ''
         AND (p_levels IS NULL OR ac_knowledge_levels(c.subject_series) IS NULL OR ac_knowledge_levels(c.subject_series) && p_levels)
         AND (p_category_classes IS NULL OR ac_category_classes(c.subject_series, c.title) IS NULL OR ac_category_classes(c.subject_series, c.title) && p_category_classes)
         AND (p_ratings IS NULL OR ac_ratings(c.subject_series) IS NULL OR ac_ratings(c.subject_series) && p_ratings))
  END;
$function$;

CREATE OR REPLACE FUNCTION public.get_study_mastery(p_item_type text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(mastered integer, seen integer, total_available integer, pct integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  with target as (
    select coalesce(p_user_id, auth.uid()) as uid
  ),
  avail AS (
    SELECT (
      CASE WHEN p_item_type IS NULL OR p_item_type = 'pcg' THEN
        (SELECT count(*) FROM pcg_terms WHERE definition IS NOT NULL AND definition <> '') ELSE 0 END
      + CASE WHEN p_item_type IS NULL OR p_item_type = 'far' THEN
        (SELECT count(*) FROM study_far_sections) ELSE 0 END
      + CASE WHEN p_item_type IS NULL OR p_item_type = 'aim' THEN
        (SELECT count(*) FROM aim_paragraphs WHERE body_text IS NOT NULL AND body_text <> '') ELSE 0 END
      + CASE WHEN p_item_type IS NULL OR p_item_type = 'ac' THEN
        (SELECT count(*) FROM advisory_circulars WHERE status = 'active' AND description IS NOT NULL AND description <> '' AND title IS NOT NULL AND title <> '') ELSE 0 END
    ) AS total
  )
  SELECT
    (SELECT count(*) FILTER (WHERE correct_streak >= 2) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type))::int AS mastered,
    (SELECT count(*) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type))::int AS seen,
    avail.total::int AS total_available,
    CASE WHEN avail.total = 0 THEN 0
      ELSE round((SELECT count(*) FILTER (WHERE correct_streak >= 2) FROM study_progress, target WHERE user_id = target.uid AND (p_item_type IS NULL OR item_type = p_item_type)) * 100.0 / avail.total)::int
    END AS pct
  FROM avail, target
  WHERE public.has_pro_access(target.uid);
$function$;

CREATE OR REPLACE FUNCTION public.get_currency()
 RETURNS TABLE(current_streak integer, longest_streak integer, last_active_date date, is_current boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT * FROM (
    SELECT
      CASE WHEN last_active_date >= current_date - 1 THEN current_streak ELSE 0 END,
      longest_streak,
      last_active_date,
      last_active_date >= current_date - 1 AS is_current
    FROM user_streaks
    WHERE user_id = auth.uid()
    UNION ALL
    SELECT 0, 0, NULL, false
    WHERE NOT EXISTS (SELECT 1 FROM user_streaks WHERE user_id = auth.uid())
    LIMIT 1
  ) t
  WHERE public.has_pro_access();
$function$;

-- Folders (Plus, capped 3/Premium unlimited) -- the numeric cap was
-- enforced, the underlying "must be Plus at all" check was not: a Free
-- account got the exact same cap of 3 as Plus/Pro (should be 0).
CREATE OR REPLACE FUNCTION public.enforce_folder_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_plus_access(NEW.user_id) THEN
    RAISE EXCEPTION 'Folders require Plus';
  END IF;
  IF (SELECT count(*) FROM synced_folders WHERE user_id = NEW.user_id AND deleted = false) >= public.folder_visible_cap() THEN
    RAISE EXCEPTION 'Folder limit reached for your current plan';
  END IF;
  RETURN NEW;
END;
$function$;
