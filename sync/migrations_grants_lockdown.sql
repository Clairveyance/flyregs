-- ============================================================================
-- Project-wide grants lockdown  --  2026-08-01
--
-- RC, after the pcg_terms fix: "yes there should be no outside permissions
-- to do anything with our app. we are the only ones who should be able to
-- change things." Auditing pcg_terms exposed a project-wide root cause, not
-- an isolated mistake: `ALTER DEFAULT PRIVILEGES ... FOR ROLE postgres IN
-- SCHEMA public` was granting full INSERT/UPDATE/DELETE/TRUNCATE to anon
-- AND authenticated on every new table automatically -- confirmed because
-- dictionary_terms (created same day with an explicit narrower GRANT in
-- its own migration) had the SAME broad grants anyway. That default was
-- fixed first (see the ALTER DEFAULT PRIVILEGES statement below), then this
-- migration cleans up all 59 tables that already existed under the old
-- default. (A second default-ACL entry for role `supabase_admin` exists
-- too but isn't alterable via the Management API connection -- tables
-- created through the Supabase Dashboard's Table Editor, rather than a SQL
-- migration, may still need a manual follow-up.)
--
-- TRUNCATE is revoked from EVERY table without exception, including the
-- ones below that keep other write grants: RLS does not apply to TRUNCATE
-- in Postgres (it's not DML), so on any table where authenticated had it,
-- ANY signed-in user could wipe the entire table for EVERY user -- not
-- just their own rows -- regardless of how tight the RLS policies are.
--
-- Two groups, built from a real grep of ac-app/src/ for `.from('TABLE')`
-- followed by `.insert(/.update(/.upsert(/.delete(` -- not assumed from
-- table names. Where a table looked like it should need a write (e.g.
-- challenge_answers, user_coins, user_duel_stats) but had none, checked
-- for an RPC-mediated path instead (challenges.ts's submit_challenge_answer
-- etc. -- the correct anti-cheat pattern: a client that could bypass that
-- RPC and write challenge_answers/user_coins/user_duel_stats directly could
-- grant itself coins or fake a duel win, which the RPC's server-side
-- validation exists specifically to prevent).
-- ============================================================================

alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate on tables from anon, authenticated;

-- Group A: zero client write path found anywhere (pure reference/system
-- data, or real writes but exclusively RPC-mediated) -- revoke ALL four
-- write privileges from both anon and authenticated.
revoke insert, update, delete, truncate on table
  public.ac_block_overrides, public.ac_figures, public.ac_formula_refs, public.ac_series,
  public.acs_areas_of_operation, public.acs_documents, public.acs_elements, public.acs_tasks,
  public.ad_part_mentions, public.advisory_circulars, public.aim_chapters, public.aim_figures,
  public.aim_paragraphs, public.aircraft_type_designators, public.airworthiness_directives,
  public.challenge_answers, public.challenge_participants, public.challenge_questions, public.challenges,
  public.content_chunks, public.content_revisions, public.device_signup_attempts, public.dictionary_terms,
  public.document_citations, public.far_parts, public.far_sections, public.figure_recovery_log,
  public.legal_interpretations, public.pcg_term_levels, public.quizzable_advisory_circulars,
  public.quizzable_aim_paragraphs, public.quizzable_far_sections, public.quizzable_pcg_terms,
  public.recent_acs, public.scraper_runs, public.search_concept_anchors, public.search_term_associations,
  public.search_vocabulary, public.series_summary, public.study_facts, public.study_progress,
  public.subscription_events, public.user_bookmarks, public.user_coins, public.user_duel_stats,
  public.vision_recovery_log
from anon, authenticated;

-- Group B: real, verified client write paths exist for signed-in users
-- (RLS-scoped, e.g. `eq('user_id', user.id)` or equivalent) -- anon still
-- has zero legitimate use case (every write path requires a real user id),
-- so anon loses everything; authenticated keeps its existing
-- insert/update/delete but loses TRUNCATE (see note above -- no legitimate
-- flow ever needs to wipe the whole table, and RLS can't protect against it
-- even if one existed).
revoke insert, update, delete, truncate on table
  public.ad_parts, public.folder_collaborators, public.push_tokens, public.synced_bookmarks,
  public.synced_folder_items, public.synced_folders, public.synced_notes, public.user_ad_notifications,
  public.user_aircraft, public.user_aircraft_equipment, public.user_aircraft_reminders,
  public.user_profile_ratings, public.user_streaks
from anon;

revoke truncate on table
  public.ad_parts, public.folder_collaborators, public.push_tokens, public.synced_bookmarks,
  public.synced_folder_items, public.synced_folders, public.synced_notes, public.user_ad_notifications,
  public.user_aircraft, public.user_aircraft_equipment, public.user_aircraft_reminders,
  public.user_profile_ratings, public.user_streaks
from authenticated;
