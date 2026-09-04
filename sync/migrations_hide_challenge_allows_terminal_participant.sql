-- hide_challenge_from_history: let a participant whose OWN role is already
-- over clear the row, even while the duel itself continues.
--
-- THE DEAD END. In a 3+ player duel, one player can forfeit or decline while
-- the others play on. Their row stays in their list, and every way out is
-- refused:
--   * swipe -> forfeit_challenge  -> "Not an active participant in this duel"
--   * swipe -> cancel_challenge   -> its non-creator UPDATE filters
--     `status in ('pending','active')`, matches ZERO rows, raises NOTHING and
--     returns success. The client removes the row optimistically, the dialog
--     closes, and the row reappears on the next focus refresh. A delete that
--     looks like it worked and didn't -- the worst of the three outcomes,
--     because nothing tells the user anything happened.
--   * swipe -> hide_challenge_from_history -> refused, because the CHALLENGE
--     is still active.
-- So the row could not be cleared until the other players happened to finish.
--
-- WHY NARROWING THE GUARD IS SAFE. It exists to stop a still-PENDING invite
-- being hidden: that participant has not responded, finalize_challenge_if_done
-- is still waiting on them, and hiding it would strand everyone. A participant
-- who has already FORFEITED or DECLINED has resolved their own role -- finalize
-- no longer waits on them -- so hiding their view of the row cannot freeze
-- anything for anyone else. `hidden_at` is per-participant, so this changes
-- only what THIS user sees.
--
-- Built additively from the LIVE pg_get_functiondef output.

CREATE OR REPLACE FUNCTION public.hide_challenge_from_history(p_challenge_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if exists (select 1 from challenges c where c.id = p_challenge_id and c.status = 'active')
     and not exists (
       select 1 from challenge_participants cp
       where cp.challenge_id = p_challenge_id
         and cp.user_id = auth.uid()
         and cp.status in ('forfeited', 'declined')
     )
  then
    raise exception 'This duel is still active -- cancel or forfeit it, not delete it from history';
  end if;

  update challenge_participants
  set hidden_at = now()
  where challenge_id = p_challenge_id and user_id = auth.uid();

  if not found then
    raise exception 'Not a participant in this duel';
  end if;
end;
$function$;
