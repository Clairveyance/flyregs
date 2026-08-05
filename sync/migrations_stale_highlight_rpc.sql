-- Stale-highlight detection without shipping gated AC content (2026-08-05).
--
-- Found during the tier-gating audit RC asked for ahead of beta. saved.tsx
-- checked whether a saved AC highlight still exists in its source document
-- by pulling `pdf_blocks` from the RAW advisory_circulars table and diffing
-- client-side. `pdf_blocks` is exactly the column advisory_circulars_gated
-- redacts for non-Plus (it truncates to the first two blocks), so this one
-- query handed a Free account the complete text of every AC it had a
-- highlight in.
--
-- The UI never RENDERED that text -- it only built a Set for comparison --
-- which is precisely why it survived earlier passes: nothing looked wrong
-- on screen. But the payload crossed the wire, so anyone watching network
-- traffic had the full paid document. A gate that leaks the data while
-- hiding the pixels is not a gate.
--
-- Switching the call to the _gated view would have "fixed" the leak by
-- breaking the feature instead: a Free user would only ever see blocks
-- 0-1, so every deeper highlight would be reported stale. So the check
-- moves server-side and returns BOOLEANS -- the comparison happens where
-- the content already lives, and nothing but a verdict comes back.
--
-- SECURITY DEFINER on purpose: it must read the ungated table to do the
-- comparison. That's safe here precisely because the return type can't
-- carry content -- the only thing a caller can learn is whether a string
-- they already possess still appears in a document they already bookmarked.

CREATE OR REPLACE FUNCTION public.stale_highlight_ac_ids(
  probes jsonb  -- [{ "ac_id": uuid, "block_text": text }, ...]
)
 RETURNS TABLE(out_ac_id uuid, out_block_text text, out_stale boolean)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
  select
    (p->>'ac_id')::uuid,
    p->>'block_text',
    not exists (
      select 1
      from advisory_circulars ac,
           lateral jsonb_array_elements(coalesce(ac.pdf_blocks, '[]'::jsonb)) blk
      where ac.id = (p->>'ac_id')::uuid
        -- Mirrors src/lib/acFormat.ts's blockText() EXACTLY, which is
        -- kind-dependent, not a single field:
        --   chapter | para  -> trim(text)
        --   section | item  -> trim(label + ' ' + title + ' ' + body)
        --   anything else   -> '' (never matches, correctly)
        -- This is now the THIRD copy of that rule (the other two are
        -- acFormat.ts itself and scripts/backfill-blocks.mjs, which keeps
        -- its own because it runs outside the RN bundler). acFormat.ts's
        -- own header already flags that duplication; changing block
        -- identity means changing all three or highlights silently start
        -- reporting stale.
        and case blk->>'kind'
              when 'chapter' then btrim(coalesce(blk->>'text', ''))
              when 'para'    then btrim(coalesce(blk->>'text', ''))
              when 'section' then btrim(concat_ws(' ', coalesce(blk->>'label', ''), coalesce(blk->>'title', ''), coalesce(blk->>'body', '')))
              when 'item'    then btrim(concat_ws(' ', coalesce(blk->>'label', ''), coalesce(blk->>'title', ''), coalesce(blk->>'body', '')))
              else ''
            end = (p->>'block_text')
    )
  from jsonb_array_elements(probes) p;
$function$;

REVOKE ALL ON FUNCTION public.stale_highlight_ac_ids(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.stale_highlight_ac_ids(jsonb) TO authenticated, anon;
