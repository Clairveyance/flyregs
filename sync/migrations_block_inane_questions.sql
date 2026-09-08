-- Server-side guard: an inane question can be INSERTED, but it can never be
-- SERVED.
--
-- RC, 2026-09-07: "def fix any issue that would cause those inane Qs to be
-- allowed into the DB. none of those types can be allowed in."
--
-- The full classifier is scripts/inane_question_sweep.py (9 rules, run in
-- run_all_audits.sh, and imported by insert_authored_questions.py so authoring
-- is gated by the same definition). But a Python gate only protects what goes
-- through that Python. This trigger is the half that cannot be bypassed --
-- anything that reaches the table by any route, now or later, is checked.
--
-- It AUTO-FLAGS rather than raising. Rejecting would mean a scraper or backfill
-- dying mid-run on one bad row, and the point is not to lose data -- it is that
-- nothing inane is ever put in front of a user. status <> 'live' is exactly
-- what get_study_queue, create_challenge and get_reg_of_the_day already
-- require, so flagging is sufficient and reversible.
--
-- Only the classes that translate cleanly and unambiguously into SQL are here.
-- obscure_acronym needs a 100-entry allowlist of acronyms pilots actually use,
-- and expired_provision needs date reasoning; both stay in the Python sweep
-- rather than being half-implemented twice. This trigger is a floor, not the
-- whole check.
--
-- NOT caught on purpose, because they are good questions:
--   answer 'Part 65'  -- knowing which part governs dispatcher certificates
--   answer 'TSO-C88'  -- knowing which TSO an altitude digitizer must meet
--   1-800-WX-BRIEF    -- a pilot really does need that number
-- The first version of the Python rule swept 252 rows and most were those.

create or replace function public.flag_inane_study_fact()
returns trigger language plpgsql as $fn$
declare
  a text := coalesce(new.answer, '');
  q text := coalesce(new.question, '');
  reason text := null;
begin
  if new.status is distinct from 'live' then
    return new;                       -- already quarantined; leave the reason alone
  end if;

  if a !~* '(WX-?BRIEF|1-?800-?992-?7433)' and (
       a ~ '\(?\d{3}\)?[-. ]\d{3}-\d{4}'
    or a ~* 'https?://|www\.'
    or a ~ '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[A-Za-z]{2,}'
    or a ~* '\mP\.?O\.? Box\M') then
    reason := 'inane:contact_details';

  elsif a ~ '^\s*§{1,2}\s*[0-9.]+[a-z()0-9]*(\s*(,|and|&|through|to|-)\s*(§{1,2}\s*)?[0-9.]+[a-z()0-9]*)*(\s+of this chapter)?\s*\.?\s*$' then
    reason := 'inane:citation_only_answer';

  elsif a ~ '^\s*[Ss]ub[Pp]arts?\s+[A-Z](\s*(,|and|&)\s*[A-Z])*\s*\.?\s*$' then
    reason := 'inane:subpart_letter_answer';

  elsif a ~* '^\s*((ICAO\s+)?Doc(ument)?\.?\s*[0-9]+[A-Z]?|FAA\s+Order\s+[A-Z]*\s*[0-9.]+[A-Z]?|IEEE\s*[0-9.]+[A-Z]?|RTCA[/ ]?DO-[0-9]+[A-Z]?|SAE\s+AS?[0-9]+[A-Z]?|MIL-[A-Z]-[0-9]+[A-Z]?|Amendment\s+[0-9-]+|SFAR\s+(No\.\s*)?[0-9]+)\s*\.?\s*$' then
    reason := 'inane:document_designator';

  elsif q ~* '(what percentage|what proportion|how many percent)' and a ~ '[0-9]+(\.[0-9]+)?\s*%' then
    reason := 'inane:study_statistic';

  elsif q ~ '\([a-z]\)\s*\([0-9]+\)\s*\((i|v|x)+\)' then
    reason := 'inane:deep_paragraph_prompt';
  end if;

  if reason is not null then
    new.status := 'flagged';
    new.flag_reason := reason;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_flag_inane_study_fact on public.study_facts;
create trigger trg_flag_inane_study_fact
  before insert or update of question, answer, status on public.study_facts
  for each row execute function public.flag_inane_study_fact();

comment on function public.flag_inane_study_fact() is
  'Auto-flags study questions whose ANSWER is a lookup rather than knowledge '
  '(phone/URL, bare citation, subpart letter, document number, study statistic) '
  'so they are never served. Full classifier: scripts/inane_question_sweep.py.';
