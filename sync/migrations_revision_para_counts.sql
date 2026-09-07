-- Paragraph counts for the What's Changed list, computed SERVER-side.
--
-- WHY
-- updates.tsx's Changed tab showed "+N −N" on every COLLAPSED row, and the
-- only way to know N was to download added_text/removed_text for all 100
-- rows. Measured 2026-09-06 on the live database: the 90-day window is
-- **12.4 MB of JSON and ~10 seconds** on a fast desktop connection, because a
-- single AC revision (29-2C) carries 2.9 MB of diff text. On a phone that is
-- RC's "spinning the wheel and the whole app locked up."
--
-- The list needs the COUNT, not the text. These two computed columns let
-- PostgREST return the counts while the text stays on the server until a row
-- is actually expanded, which takes the same request from 12.4 MB to ~6 KB.
--
-- WHY IT IS A FUNCTION ON THE GATED VIEW, NOT A COLUMN ON THE TABLE
-- content_revisions_gated redacts added_text/removed_text to NULL below the
-- required tier. Taking the view row as the argument means the count is
-- computed from the value THAT USER can actually see, so a redacted row
-- counts 0 -- exactly what the client rendered before this change (null ->
-- splitParagraphs -> []). A column on the base table would have leaked the
-- size of content the caller is not entitled to read.
--
-- The logic mirrors splitParagraphs() in src/lib/whatsChanged.ts exactly:
-- split on a blank line, strip the private-use table-header sentinel
-- (U+E000), drop anything blank after trimming. If that function ever
-- changes, change this in the same commit or the collapsed counts silently
-- stop matching the expanded diff.

create or replace function public.revision_added_count(r public.content_revisions_gated)
returns integer
language sql
stable
parallel safe
as $$
  select count(*)::int
  from unnest(string_to_array(coalesce(r.added_text, ''), E'\n\n')) as p
  where btrim(replace(p, U&'\E000', '')) <> ''
$$;

create or replace function public.revision_removed_count(r public.content_revisions_gated)
returns integer
language sql
stable
parallel safe
as $$
  select count(*)::int
  from unnest(string_to_array(coalesce(r.removed_text, ''), E'\n\n')) as p
  where btrim(replace(p, U&'\E000', '')) <> ''
$$;

-- Read-only computed columns: same audience as the view itself.
grant execute on function public.revision_added_count(public.content_revisions_gated) to anon, authenticated;
grant execute on function public.revision_removed_count(public.content_revisions_gated) to anon, authenticated;
