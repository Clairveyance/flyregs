-- Thirty-three RLS policies that existed ONLY in the live database.
--
-- Captured 2026-09-18 by comparing every policy in `public` against every
-- CREATE POLICY in sync/ or migrations/. These are the app's ACCESS CONTROL --
-- among them users_manage_own_synced_bookmarks and users_manage_own_synced_notes,
-- which are the per-user data isolation for notes and bookmarks, and most of
-- the folder-sharing rules.
--
-- Several are clearly dashboard-created: Supabase's UI names a policy
-- "far_sections public read", with spaces, which no hand-written migration in
-- this repo does. Convenient at the time, invisible to the repo afterwards.
--
-- WHY THIS IS NOT TIDINESS. There is no point-in-time recovery on this project,
-- only daily snapshots (memory/supabase_backup_posture_no_pitr.md). A snapshot
-- restores these. The repository did not describe them -- so anyone reading it
-- to answer "who can read this table" got a partial answer with no way to know
-- it was partial, and anyone rebuilding from it would have produced a database
-- with different security.
--
-- Bodies are the LIVE definitions, read from pg_policies via the Management API
-- (not apply_migration.py, which truncates at 2000 characters). Applying this
-- file is a no-op against the current database by construction; it exists so
-- the repo stops being incomplete.
--
-- scripts/live_policy_has_a_definition_audit.py fails if a thirty-fourth appears.

begin;

-- acs_areas_of_operation
create policy "acs_areas_of_operation public read" on public.acs_areas_of_operation
  for select
  to public
  using (true);

-- acs_documents
create policy "acs_documents public read" on public.acs_documents
  for select
  to public
  using (true);

-- acs_task_reg_links
create policy "acs_task_reg_links_public_read" on public.acs_task_reg_links
  for select
  to public
  using (true);

-- ad_parts
create policy "ad_parts_suggest" on public.ad_parts
  for insert
  to public
  with check (((auth.uid() IS NOT NULL) AND (source = 'user_suggested'::text) AND (status = 'pending_review'::text) AND (suggested_by = auth.uid())));

-- advisory_circulars
create policy "ACs public read" on public.advisory_circulars
  for select
  to public
  using (true);

-- aim_chapters
create policy "aim_chapters public read" on public.aim_chapters
  for select
  to public
  using (true);

-- aim_figures
create policy "aim_figures public read" on public.aim_figures
  for select
  to public
  using (true);

-- aim_paragraphs
create policy "aim_paragraphs public read" on public.aim_paragraphs
  for select
  to public
  using (true);

-- airworthiness_directives
create policy "public_read_ads" on public.airworthiness_directives
  for select
  to public
  using (true);

-- challenge_answers
create policy "challenge_answers_own_write" on public.challenge_answers
  for insert
  to public
  with check (((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM (challenge_questions cq
     JOIN challenge_participants cp ON ((cp.challenge_id = cq.challenge_id)))
  WHERE ((cq.id = challenge_answers.challenge_question_id) AND (cp.user_id = auth.uid()))))));

-- challenge_answers
create policy "challenge_answers_participants_read" on public.challenge_answers
  for select
  to public
  using (((EXISTS ( SELECT 1
   FROM (challenge_questions cq
     JOIN challenge_participants cp ON ((cp.challenge_id = cq.challenge_id)))
  WHERE ((cq.id = challenge_answers.challenge_question_id) AND (cp.user_id = auth.uid())))) AND ((user_id = auth.uid()) OR has_answered_challenge_question(challenge_question_id))));

-- challenge_questions
create policy "challenge_questions_participants" on public.challenge_questions
  for select
  to public
  using ((EXISTS ( SELECT 1
   FROM challenge_participants cp
  WHERE ((cp.challenge_id = challenge_questions.challenge_id) AND (cp.user_id = auth.uid())))));

-- content_revisions
create policy "content_revisions public read" on public.content_revisions
  for select
  to public
  using (true);

-- document_citations
create policy "document_citations public read" on public.document_citations
  for select
  to public
  using (true);

-- far_parts
create policy "far_parts public read" on public.far_parts
  for select
  to public
  using (true);

-- far_sections
create policy "far_sections public read" on public.far_sections
  for select
  to public
  using (true);

-- folder_collaborators
create policy "owners_remove_collaborators" on public.folder_collaborators
  for delete
  to authenticated
  using ((auth.uid() = owner_id));

-- folder_collaborators
create policy "owners_view_folder_collaborators" on public.folder_collaborators
  for select
  to authenticated
  using ((auth.uid() = owner_id));

-- folder_collaborators
create policy "users_leave_shared_folder" on public.folder_collaborators
  for delete
  to authenticated
  using ((auth.uid() = user_id));

-- folder_collaborators
create policy "users_mark_own_collaboration_viewed" on public.folder_collaborators
  for update
  to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- folder_collaborators
create policy "users_view_own_collaborations" on public.folder_collaborators
  for select
  to authenticated
  using ((auth.uid() = user_id));

-- legal_interpretations
create policy "legal_interpretations public read" on public.legal_interpretations
  for select
  to public
  using (true);

-- pcg_terms
create policy "pcg_terms public read" on public.pcg_terms
  for select
  to public
  using (true);

-- push_tokens
create policy "users_manage_own_push_tokens" on public.push_tokens
  for all
  to authenticated
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- study_item_topics
create policy "study_item_topics_public_read" on public.study_item_topics
  for select
  to anon,authenticated
  using (true);

-- study_progress
create policy "study_progress_own_rows" on public.study_progress
  for all
  to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- synced_bookmarks
create policy "users_manage_own_synced_bookmarks" on public.synced_bookmarks
  for all
  to authenticated
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- synced_notes
create policy "users_manage_own_synced_notes" on public.synced_notes
  for all
  to authenticated
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- user_coins
create policy "user_coins_own_rows" on public.user_coins
  for all
  to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- user_duel_stats
create policy "user_duel_stats_own_write" on public.user_duel_stats
  for all
  to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- user_profile_ratings
create policy "user_profile_ratings_own_rows" on public.user_profile_ratings
  for all
  to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- user_streaks
create policy "user_streaks_own_rows" on public.user_streaks
  for all
  to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- user_streaks
create policy "user_streaks_public_stats_read" on public.user_streaks
  for select
  to authenticated
  using ((stats_visible = true));

commit;
