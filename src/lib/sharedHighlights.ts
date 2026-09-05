import * as Sentry from '@sentry/react-native'
import { supabase } from '@/lib/supabase'
import type { FolderItemType } from '@/lib/folders'
import { getHighlightsForAC } from '@/lib/bookmarks'

// Other participants' highlights on the document you are reading.
//
// RC, 2026-09-05: "if the folder is read/write access between the
// participants then everybody who has read/write access must be able to both
// see the other person's added highlights even after the folder has been
// shared... and they must show up immediately on everybody's phone who is
// participating."
//
// The server side of that rule was already correct and is proven by
// scripts/shared_folder_highlights_e2e_test.py (21 checks against the live
// project with real user JWTs). What was missing was any client that ASKED:
// getHighlightsForAC() in lib/bookmarks.ts reads local AsyncStorage and
// nothing else, so a document screen has only ever been able to draw your own
// highlights. Another participant's highlight was stored, synced and readable
// -- and invisible.
//
// See sync/migrations_shared_highlights.sql for get_shared_highlights and why
// it is SECURITY INVOKER.
export interface SharedHighlight {
  id: string
  ownerId: string
  /** Callsign where they have one, else a neutral word -- never an email. */
  ownerLabel: string
  blockKind: string | null
  blockLabel: string | null
  blockSnippet: string | null
  blockText: string
  /** Whether THIS viewer may change or remove it. Comes from the server so
   *  the UI cannot offer an action the database will refuse. */
  canEdit: boolean
}

/** Shared highlights for one document, keyed by the exact passage text --
 *  which is what a block renderer has in hand. */
export type SharedHighlightMap = Map<string, SharedHighlight>

const EMPTY: SharedHighlightMap = new Map()

/** Fetch other participants' highlights for a document.
 *
 * NEVER THROWS. A document must render whether or not this call succeeds:
 * these highlights are an addition to the page, and a network blip must not
 * turn into a blank screen or a lost read. On any failure it returns an empty
 * map, which renders exactly as the app did before this existed. */
export async function getSharedHighlightsForDoc(
  acId: string | null | undefined,
  itemType: FolderItemType,
): Promise<SharedHighlightMap> {
  if (!acId) return EMPTY
  try {
    const { data, error } = await supabase.rpc('get_shared_highlights', {
      p_item_type: itemType,
      p_ac_id: acId,
    })
    // supabase-js RESOLVES {data, error} rather than throwing, so this check
    // is the only thing standing between a failed call and "nobody else has
    // highlighted anything here" -- which would be a confident lie.
    if (error) {
      Sentry.captureException(error, {
        tags: { feature: 'shared_highlights' }, extra: { acId, itemType },
      })
      return EMPTY
    }
    const map: SharedHighlightMap = new Map()
    for (const row of (data ?? []) as any[]) {
      if (!row?.block_text) continue
      const existing = map.get(row.block_text)
      // Two people can highlight the SAME passage. The map is keyed by the
      // passage, so keep the one this viewer is allowed to act on -- offering
      // "remove" for a highlight they cannot touch is worse than not offering
      // it, and the two render identically either way.
      if (existing && !row.can_edit) continue
      map.set(row.block_text, {
        id: row.id,
        ownerId: row.owner_id,
        ownerLabel: row.owner_label ?? 'A collaborator',
        blockKind: row.block_kind ?? null,
        blockLabel: row.block_label ?? null,
        blockSnippet: row.block_snippet ?? null,
        blockText: row.block_text,
        canEdit: row.can_edit === true,
      })
    }
    return map
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'shared_highlights' }, extra: { acId, itemType } })
    return EMPTY
  }
}

/** Remove someone else's highlight from the shared folder it lives in.
 *
 * Soft-delete, exactly like the local path (removeManyBookmarks marks
 * `deleted`), so the other person's device converges on the removal through
 * the same sync it already runs rather than finding a row that vanished.
 * Returns false when the write was refused -- which, because PostgREST answers
 * an RLS-filtered UPDATE with 200 and ZERO rows rather than an error, is
 * measured by what came back and not by the absence of an error. */
export async function removeSharedHighlight(id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('synced_bookmarks')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
  if (error) {
    Sentry.captureException(error, { tags: { feature: 'shared_highlights' }, extra: { id, stage: 'remove' } })
    return false
  }
  return Array.isArray(data) && data.length > 0
}

/** Everything a document screen needs to draw highlights: the set of passages
 *  to shade, and who owns the ones that aren't yours.
 *
 * ONE call site per screen instead of two, because the two must never be
 * fetched independently -- a screen that had the local set but not the shared
 * map would shade another person's passage and then, on a long-press, fail to
 * find it locally and cheerfully create a DUPLICATE highlight of the same
 * text. Returning them together makes that state unrepresentable.
 *
 * The local read comes first and is awaited on its own: your own highlights
 * are on-device and instant, and must never wait on, or be lost to, a network
 * call (getSharedHighlightsForDoc already swallows its own failures). */
export async function loadHighlightSets(
  acId: string | null | undefined,
  itemType: FolderItemType,
): Promise<{ texts: Set<string>; shared: SharedHighlightMap }> {
  const mine = await getHighlightsForAC(acId ?? '', itemType)
  const texts = new Set(mine.map((h) => h.blockText!).filter(Boolean))
  const shared = await getSharedHighlightsForDoc(acId, itemType)
  for (const text of shared.keys()) {
    // A passage you have ALSO highlighted yourself stays yours: it is already
    // in `texts`, and the screen checks its own set first, so the long-press
    // menu offers "Remove Highlight" for your own copy rather than an action
    // on someone else's row.
    texts.add(text)
  }
  return { texts, shared }
}
