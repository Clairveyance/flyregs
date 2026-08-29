-- 2026-08-29, full-sweep pass 8 (Study Mode/Duels), background agent audit.
-- challenge_questions.correct_answer had no narrower column-level grant
-- than any other column, and its RLS policy (challenge_questions_
-- participants) only checks "is a participant of this challenge" -- true
-- the instant you're invited, well before you accept or answer anything.
-- get_next_challenge_question() (the SECURITY DEFINER RPC the real app UI
-- calls, confirmed live via pg_get_functiondef) is already correctly
-- written to never return correct_answer -- but any participant could
-- bypass it entirely with a direct table read:
--   supabase.from('challenge_questions').select('item_id,correct_answer')
--     .eq('challenge_id', id)
-- returning the full answer key for every question in the duel before
-- tapping GO, defeating the "one shot, timed" mechanic the whole Duels UI
-- is built around. challenge_answers' own RLS is correctly scoped by
-- contrast (user_id = auth.uid() OR has_answered_challenge_question(...))
-- -- this gap is specific to challenge_questions.
--
-- Confirmed safe to close: repo-wide grep found zero client-side (src/)
-- reads of challenge_questions at all -- the app always goes through
-- get_next_challenge_question()/submit_challenge_answer(), both SECURITY
-- DEFINER, needing no caller-side grant on this column. choices is left
-- granted -- it's the shuffled option text the RPC itself also returns,
-- with no answer indicator embedded in it (confirmed by reading the RPC's
-- own live definition).
--
-- A plain `REVOKE SELECT (correct_answer) ON ... FROM anon, authenticated`
-- alone does NOT work here -- caught live, before considering this done,
-- by actually re-testing the exploit with two real disposable accounts
-- after applying it and finding it still leaked. Root cause: a pre-existing
-- WHOLE-TABLE `GRANT SELECT ON challenge_questions TO anon, authenticated`
-- already covers every column, and a narrower column-level REVOKE doesn't
-- override a broader table-level GRANT in Postgres's ACL model -- it only
-- removes a column grant that was itself given at the column level. Same
-- REVOKE-the-whole-table-then-GRANT-back-the-safe-columns pattern already
-- used successfully twice tonight (migrations_fix_cfr49_body_text_column_
-- grant_leak.sql, the synced_bookmarks fix) is required here too.
do $$
declare
  denied text[] := array['correct_answer'];
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'challenge_questions'
     and not (column_name = any(denied));

  execute format('revoke select on public.challenge_questions from anon, authenticated');
  execute format('grant select (%s) on public.challenge_questions to anon, authenticated', cols);
end $$;
