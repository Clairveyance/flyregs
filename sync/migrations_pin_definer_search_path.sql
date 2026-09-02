-- Pin search_path on the 29 SECURITY DEFINER functions that lacked it (2026-09-03)
--
-- A SECURITY DEFINER function runs as the owner and resolves unqualified names
-- against the CALLER-influenced search_path. 71 of this project's 100 definer
-- functions already pin it; these 29 were drift, not policy.
--
-- has_aircraft_access() is the one that actually matters: it is the USING
-- clause of five RLS policies (user_aircraft, user_ad_notifications,
-- user_aircraft_equipment, user_aircraft_reminders, and the aircraft-images
-- storage policies), so a resolution hijack there is an authorization bypass
-- rather than merely a data bug.
--
-- related_by_topic() is worth calling out separately: it sets hnsw.ef_search
-- and so LOOKS pinned at a glance, but had no search_path. Adding one does not
-- disturb the existing setting -- proconfig holds both.
--
-- 'public', 'pg_temp' matches what the other 71 already use; pg_temp last is
-- the standard guard against a caller planting a temp-schema shadow.

begin;

alter function public.cancel_challenge(p_challenge_id uuid) set search_path to 'public', 'pg_temp';
alter function public.create_challenge(p_opponent_ids uuid[], p_question_count integer, p_item_types text[], p_levels text[], p_category_classes text[]) set search_path to 'public', 'pg_temp';
alter function public.filter_documents(p_content_types text[], p_far_parts text[], p_ac_series text, p_audience text[], p_cites_type text, p_cites_id text, p_date_from date, p_date_to date, p_has_figures boolean, p_limit integer, p_offset integer) set search_path to 'public', 'pg_temp';
alter function public.finalize_challenge_if_done(p_challenge_id uuid) set search_path to 'public', 'pg_temp';
alter function public.forfeit_challenge(p_challenge_id uuid) set search_path to 'public', 'pg_temp';
alter function public.get_challenge_results(p_challenge_id uuid) set search_path to 'public', 'pg_temp';
alter function public.get_challenge_standings(p_challenge_id uuid) set search_path to 'public', 'pg_temp';
alter function public.get_challengeable_users() set search_path to 'public', 'pg_temp';
alter function public.get_collaboration_invite_push_target(p_target_user_id uuid, p_resource_type text, p_resource_label text, p_token text) set search_path to 'public', 'pg_temp';
alter function public.get_currency() set search_path to 'public', 'pg_temp';
alter function public.get_duel_push_target(p_challenge_id uuid, p_event text) set search_path to 'public', 'pg_temp';
alter function public.get_duel_stats(p_user_id uuid) set search_path to 'public', 'pg_temp';
alter function public.get_my_challenges() set search_path to 'public', 'pg_temp';
alter function public.get_my_coins() set search_path to 'public', 'pg_temp';
alter function public.get_next_challenge_question(p_challenge_id uuid) set search_path to 'public', 'pg_temp';
alter function public.get_reg_of_the_day(for_date date) set search_path to 'public', 'pg_temp';
alter function public.get_study_pool_count(p_item_types text[], p_levels text[], p_category_classes text[]) set search_path to 'public', 'pg_temp';
alter function public.get_study_queue(p_limit integer, p_item_types text[], p_levels text[], p_category_classes text[]) set search_path to 'public', 'pg_temp';
alter function public.get_unseen_coins() set search_path to 'public', 'pg_temp';
alter function public.get_visible_users() set search_path to 'public', 'pg_temp';
alter function public.has_aircraft_access(p_aircraft_id uuid, p_require_editor boolean) set search_path to 'public', 'pg_temp';
alter function public.hide_challenge_from_history(p_challenge_id uuid) set search_path to 'public', 'pg_temp';
alter function public.mark_coins_seen(p_coin_codes text[]) set search_path to 'public', 'pg_temp';
alter function public.match_contacts_by_email(p_email_hashes text[]) set search_path to 'public', 'pg_temp';
alter function public.match_contacts_by_phone(p_phone_hashes text[]) set search_path to 'public', 'pg_temp';
alter function public.record_study_review(p_item_id text, p_correct boolean, p_item_type text) set search_path to 'public', 'pg_temp';
alter function public.related_by_topic(p_source_type text, p_source_id text, p_target_types text[], p_match_count integer, p_min_similarity double precision, p_per_type_floor integer) set search_path to 'public', 'pg_temp';
alter function public.respond_to_challenge(p_challenge_id uuid, p_accept boolean) set search_path to 'public', 'pg_temp';
alter function public.submit_challenge_answer(p_question_id uuid, p_answer_text text, p_time_ms integer) set search_path to 'public', 'pg_temp';
commit;
