-- Index the columns that RLS policies filter on.
--
-- Found in the 2026-09-06 data-integrity sweep: 18 foreign keys in public have
-- no index behind them. Most do not matter -- they are on small static corpus
-- tables, and an index there costs space on a 1.2 GB database for nothing.
--
-- These five are different: each one is the predicate of an RLS POLICY, so it
-- is evaluated on every row of every query against that table, for every user,
-- forever. With three accounts the difference is unmeasurable; the point is
-- that it degrades invisibly and all at once -- a sequential scan inside a
-- policy is not slow until it is, and nothing in the app would report it.
--
--   folder_collaborators   users_view_own_collaborations      USING (auth.uid() = user_id)
--   folder_collaborators   owners_view_folder_collaborators   USING (auth.uid() = owner_id)
--   aircraft_collaborators users_view_own_aircraft_collabs    USING (auth.uid() = user_id)
--   aircraft_collaborators owners_view_aircraft_collaborators USING (auth.uid() = owner_id)
--   challenge_participants challenge_participants_own_rows    USING (user_id = auth.uid())
--
-- has_folder_access() and has_aircraft_access() filter on (folder_id, user_id)
-- and (aircraft_id, user_id), which the primary keys already cover -- those are
-- fine. It is the policies that filter on user_id or owner_id ALONE that have
-- nothing to use.
--
-- An index changes no query's RESULTS, only its plan, so this is not a
-- behaviour change and needs no re-verification of anything above it.
-- Deliberately NOT indexing far_sections.part, aim_paragraphs.chapter,
-- dictionary_terms.pcg_term_id and the rest of the corpus FKs: those tables are
-- small, static, and read through their own purpose-built indexes already.

begin;

create index if not exists idx_folder_collaborators_user
  on public.folder_collaborators (user_id);
create index if not exists idx_folder_collaborators_owner
  on public.folder_collaborators (owner_id);
create index if not exists idx_aircraft_collaborators_user
  on public.aircraft_collaborators (user_id);
create index if not exists idx_aircraft_collaborators_owner
  on public.aircraft_collaborators (owner_id);
create index if not exists idx_challenge_participants_user
  on public.challenge_participants (user_id);

commit;
