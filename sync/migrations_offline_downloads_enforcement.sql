-- Fixes P2-6 from the 2026-08-22 gating audit: offline downloads
-- (marketed Premium-exclusive: "Offline downloads -- no internet
-- required") had ZERO server-side enforcement -- src/lib/downloads.ts is
-- pure AsyncStorage, confirmed live (grep -c supabase == 0). A Plus (or
-- even Free) account with a patched client got the marketed Premium
-- feature for free.
--
-- Real architecture decision, not a quick patch: the underlying CONTENT
-- isn't secret -- a Plus subscriber already legitimately receives the
-- exact same AC/AD/FAR/etc bytes over the wire reading it online (per
-- advisory_circulars_gated and friends), and even a Free user can read
-- FAR/AIM/PCG text for free. There is no cryptographic way to let someone
-- READ content online while preventing them from SAVING what they just
-- received -- that would be true of any reading app, not a FlyRegs-
-- specific gap. What IS real and enforceable is the tier boundary on the
-- ACTION of marking something for offline caching in the first place --
-- exactly the same shape as the aircraft/folder caps already enforced
-- elsewhere in this app (real growth capped server-side; nothing already
-- saved gets revoked out from under someone on a downgrade).
--
-- Design: a real tracking table + a security-definer RPC gate on ADDING a
-- new download (Premium required), with removal always allowed. A
-- downgrade does NOT delete anything already cached locally -- consistent
-- with this app's standing "never silently destroy local-only data"
-- posture (see AircraftDowngradeGate/folder downgrade handling, this same
-- session) -- it only stops new items from being added going forward.
create table if not exists public.user_offline_downloads (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null,
  item_id text not null,
  downloaded_at timestamptz not null default now(),
  primary key (user_id, item_type, item_id)
);

alter table public.user_offline_downloads enable row level security;

drop policy if exists user_offline_downloads_own_select on public.user_offline_downloads;
create policy user_offline_downloads_own_select on public.user_offline_downloads
  for select using (auth.uid() = user_id);

drop policy if exists user_offline_downloads_own_delete on public.user_offline_downloads;
create policy user_offline_downloads_own_delete on public.user_offline_downloads
  for delete using (auth.uid() = user_id);
-- No direct INSERT/UPDATE policy -- writes only go through
-- record_offline_download() below (security definer), so the Premium
-- check can never be bypassed by a client writing the table directly.

grant select, delete on public.user_offline_downloads to authenticated;

create or replace function public.record_offline_download(p_item_type text, p_item_id text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not exists (select 1 from user_entitlements e where e.user_id = auth.uid() and e.is_premium = true) then
    raise exception 'Offline downloads require Premium';
  end if;
  insert into user_offline_downloads (user_id, item_type, item_id)
  values (auth.uid(), p_item_type, p_item_id)
  on conflict (user_id, item_type, item_id) do update set downloaded_at = now();
end;
$function$;

grant execute on function public.record_offline_download(text, text) to authenticated;

create or replace function public.remove_offline_download(p_item_type text, p_item_id text)
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  delete from user_offline_downloads
  where user_id = auth.uid() and item_type = p_item_type and item_id = p_item_id;
$function$;

grant execute on function public.remove_offline_download(text, text) to authenticated;
