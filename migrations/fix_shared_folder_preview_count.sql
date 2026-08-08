-- get_shared_folder_preview only ever counted item_type = 'ac' and 'note',
-- so a shared folder containing FAR/AIM/P-CG/AD/LOI/dictionary items (any
-- non-AC, non-note type) reported those as invisible -- the iMessage/OG
-- preview card showed e.g. "(1 AC)" for a folder that actually had 4 items
-- across 3 different types. Per RC: with this many content types now
-- folderable, breaking the count down by type would get cramped in the
-- small preview-card space -- just return one total count across every
-- type instead.
--
-- Return type changes (2 int columns -> 1), so CREATE OR REPLACE can't be
-- used here -- Postgres rejects a return-type change on an existing
-- function. Drop and recreate.
drop function if exists public.get_shared_folder_preview(text);

create function public.get_shared_folder_preview(p_token text)
returns table (out_folder_name text, out_item_count int)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_folder_id text;
begin
  select id into v_folder_id
  from synced_folders
  where share_token = p_token and deleted = false;

  if not found then
    return;
  end if;

  return query
  select
    f.name,
    (select count(*)::int from synced_folder_items i where i.folder_id = f.id and i.deleted = false)
  from synced_folders f
  where f.id = v_folder_id;
end;
$function$;

grant execute on function public.get_shared_folder_preview(text) to anon;
