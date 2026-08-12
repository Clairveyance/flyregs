-- Fix: Duel win coin toast only ever showed to whichever player's
-- submission happened to complete the challenge (finalize_challenge_if_done
-- gates v_new_coins on `auth.uid() = v_rank.user_id`, i.e. only the caller
-- of THAT specific RPC call), not the actual winner if that was the other
-- player. The coin itself was always correctly written to user_coins for
-- the real winner -- this only fixes the NOTIFICATION, which was timing-
-- dependent on an async multiplayer game where players routinely submit
-- hours or days apart.
--
-- Fix: track whether a coin has been shown yet, independent of which
-- specific RPC call earned it. Any screen the user opens after their win
-- (Duels hub is the natural one) checks for unseen coins and reveals them
-- then, instead of relying on the finalize call's own response.

alter table public.user_coins add column if not exists seen_at timestamptz;

CREATE OR REPLACE FUNCTION public.get_unseen_coins()
 RETURNS TABLE(coin_code text, earned_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT coin_code, earned_at FROM user_coins WHERE user_id = auth.uid() AND seen_at IS NULL ORDER BY earned_at;
$function$;

CREATE OR REPLACE FUNCTION public.mark_coins_seen(p_coin_codes text[])
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  UPDATE user_coins SET seen_at = now()
  WHERE user_id = auth.uid() AND coin_code = ANY(p_coin_codes) AND seen_at IS NULL;
$function$;

-- Coins earned before this fix shipped (via the old timing-dependent path)
-- were already shown to whoever triggered finalization at the time -- mark
-- everything that already exists as seen so this doesn't dump a backlog of
-- old-coin toasts on next launch. Only coins earned from here forward go
-- through the new unseen-check path.
UPDATE public.user_coins SET seen_at = earned_at WHERE seen_at IS NULL;
