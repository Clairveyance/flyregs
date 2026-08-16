-- Two RC asks from the same message (2026-08-16):
--
-- 1. "what does that duel not. say?... it should say something like 'RC1
--    is challenging you to a duel. Accept/Decline'" -- the invite push's
--    body just said "{name} challenged you to a duel", no call to action.
--
-- 2. "we have a toggle and push notif to the DailyReg, but i don't think
--    we have that same thing for the DailyWord. We should. and the push
--    not. should gate to same tier that gets the DW itself." -- confirmed
--    live: no word_of_day_enabled column, no toggle, no send script for
--    DailyWord existed. Also confirmed live that DailyWord's OWN content
--    gate is has_plus_access() (Plus), genuinely different from DailyReg's
--    has_pro_access() (Pro) -- the notifications.ts comment claiming
--    DailyWord was "gated Plus+ same as DailyReg" was itself wrong (DailyReg
--    is Pro-gated, not Plus), so the new push toggle/sender must gate on
--    Plus specifically, not copy DailyReg's Pro check blind.

-- get_duel_push_target: 'invited' body now names the action explicitly,
-- matching RC's own suggested wording. 'accepted'/'completed' left as-is
-- -- RC's ask was specifically about the invite (the one you can act on
-- from the lock screen without opening the app first).
CREATE OR REPLACE FUNCTION public.get_duel_push_target(p_challenge_id uuid, p_event text)
 RETURNS TABLE(expo_push_token text, title text, body text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_label text;
begin
  select coalesce(cr.callsign, u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))
  into v_actor_label
  from auth.users u
  left join callsign_registry cr on cr.user_id = u.id
  where u.id = v_actor_id;

  return query
  select pt.expo_push_token,
    case p_event
      when 'invited' then 'Duel Invite'
      when 'accepted' then 'Duel Accepted'
      when 'completed' then 'Duel Finished'
      else 'Duel Update'
    end,
    case p_event
      when 'invited' then v_actor_label || ' is challenging you to a duel. Accept or decline?'
      when 'accepted' then v_actor_label || ' accepted your duel — your move'
      when 'completed' then 'See how you did against ' || v_actor_label
      else 'Check your Duel with ' || v_actor_label
    end
  from challenge_participants cp
  join push_tokens pt on pt.user_id = cp.user_id
  where cp.challenge_id = p_challenge_id
    and cp.user_id != v_actor_id
    and pt.enabled = true
    and pt.duel_notifications_enabled = true
    and (
      (p_event = 'invited' and cp.status = 'pending')
      or (p_event = 'accepted' and cp.is_creator = true)
      or (p_event = 'completed' and cp.status = 'active')
    );
end;
$function$;

-- DailyWord push: own opt-in column, mirroring reg_of_day_enabled exactly.
alter table public.push_tokens add column if not exists word_of_day_enabled boolean not null default false;

-- get_word_of_the_day needs the same service_role escape hatch
-- get_reg_of_the_day already has -- the send script authenticates with the
-- service key (no auth.uid()), so has_plus_access() alone would redact the
-- real term/definition it needs to build the notification body. The
-- per-recipient Plus check still happens in the send script itself
-- (mirroring send-reg-of-day.mjs's per-recipient Pro check), same as
-- get_reg_of_the_day's existing pattern -- this only lets the trusted
-- service-role script itself read the ungated content.
CREATE OR REPLACE FUNCTION public.get_word_of_the_day(for_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(slug text, term text, definition text, source text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with pool as (
    select slug, term, (senses->0->>'definition') as definition, source,
           case when pcg_term_id is not null then 20 else 0 end as weight
    from dictionary_terms
    where senses->0->>'definition' is not null
      and length(senses->0->>'definition') >= 40
      and (senses->0->>'definition') not ilike 'see %'
  ),
  bucketed as (
    select *,
           sum(weight + 1) over (order by slug rows between unbounded preceding and current row) as bucket_hi,
           sum(weight + 1) over (order by slug rows between unbounded preceding and 1 preceding) as bucket_lo
    from pool
  ),
  totaled as (select sum(weight + 1) as total_weight from pool)
  select b.slug, b.term,
         case when public.has_plus_access() or auth.role() = 'service_role' then b.definition else null end as definition,
         b.source
  from bucketed b, totaled t
  where (abs(hashtext('word-' || for_date::text)) % t.total_weight) >= coalesce(b.bucket_lo, 0)
    and (abs(hashtext('word-' || for_date::text)) % t.total_weight) < b.bucket_hi;
$function$;
