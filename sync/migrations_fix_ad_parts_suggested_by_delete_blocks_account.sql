-- 2026-08-29, full-sweep pass 5 (Onboarding/Auth), background agent audit.
-- delete-account (supabase/functions/delete-account/index.ts) deletes the
-- auth.users row via the admin API and relies on every dependent table's FK
-- cascading -- confirmed live that 11 of the 12 tables it names do. The one
-- exception: ad_parts.suggested_by -> auth.users(id) was ON DELETE NO ACTION
-- (confdeltype 'a'), not a cascade and not a null-out. src/lib/adParts.ts's
-- suggestPart() is a real, live "Suggest a Part" feature that writes this
-- column -- not dead code -- so any user who ever suggested a part would
-- have their own account-deletion request fail server-side on a foreign-key
-- violation, with no way to self-delete afterward (the edge function logs
-- the failure and returns 500; account.tsx's runAccountDelete just shows
-- "Couldn't Delete Account" indefinitely, no retry path that would ever
-- succeed). 0 of 4,005 ad_parts rows currently have suggested_by set, so
-- this hasn't hit a real user yet, but the write path is live and this is
-- exactly the kind of "will silently strand someone the first time they use
-- an otherwise-normal feature" gap RC's full-sweep directive is hunting for.
--
-- Fixed to SET NULL rather than CASCADE -- the suggestion itself is real
-- community data worth keeping (it's informational, not user-owned content
-- like a bookmark or reminder), it just shouldn't keep pointing at a
-- deleted account. Column is already nullable, confirmed live before this.
alter table public.ad_parts
  drop constraint ad_parts_suggested_by_fkey,
  add constraint ad_parts_suggested_by_fkey
    foreign key (suggested_by) references auth.users(id) on delete set null;
