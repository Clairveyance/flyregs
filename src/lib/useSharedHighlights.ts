import { useCallback, useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { loadHighlightSets, type SharedHighlightMap } from '@/lib/sharedHighlights'
import type { FolderItemType } from '@/lib/folders'

/**
 * Keeps a document screen's highlight sets current — yours AND your
 * collaborators'.
 *
 * RC's spec for shared highlights: "all participants who have it should be able
 * to edit, add, delete and change any highlights, and they must show up
 * IMMEDIATELY on everybody's phone who is participating."
 *
 * All seven document screens loaded them exactly once, in a `useEffect` keyed
 * on the document id, and then never again. So if you were reading § 91.155
 * while your CFI highlighted a passage in a folder you both share, you did not
 * see it — not in 45 seconds, not ever, until you left the screen and came
 * back. Same defect as the shared-folder refresh gap fixed earlier the same day
 * (see useSharedScreenRefresh.ts), on a different set of screens: the folder
 * screens got all four refresh triggers, the reader screens got none.
 *
 * WHY THIS SUBSCRIBES TO synced_folder_items AND NOT synced_bookmarks.
 * get_shared_highlights only returns a highlight that is JOINED to a live
 * synced_folder_items row — a collaborator's highlight is visible to you
 * because it was filed into a folder you share, not merely because they made
 * it. So the folder-item row is both the thing that makes a highlight appear
 * AND a table already in the supabase_realtime publication. Subscribing there
 * costs no new publication, no new load on a high-write table, and fires on
 * exactly the event that changes the answer.
 *
 * What that does NOT cover is a collaborator EDITING or REMOVING an existing
 * highlight — removeSharedHighlight flips synced_bookmarks.deleted and never
 * touches the folder item, so no event fires. Focus and OS-foreground catch
 * those, which is why all three triggers are here and not just the live one.
 * Deliberately no periodic timer: unlike a shared folder screen, a reader is
 * usually alone, and polling every open document for every user would be real
 * server load for an event that mostly never comes.
 */
export function useSharedHighlights(
  acId: string | null | undefined,
  itemType: FolderItemType,
  apply: (sets: { texts: Set<string>; shared: SharedHighlightMap }) => void,
) {
  // Screens pass an inline arrow, which is a new function every render. Held in
  // a ref so it never re-subscribes the channel or re-fires the effects.
  const applyRef = useRef(apply)
  applyRef.current = apply

  const reload = useCallback(() => {
    if (!acId) return
    loadHighlightSets(acId, itemType)
      .then((sets) => applyRef.current(sets))
      // loadHighlightSets already reports its own failures; a reload that
      // cannot complete must leave what is on screen alone rather than
      // clearing it to "nobody has highlighted anything", which would be a
      // confident lie (the same reasoning getSharedHighlightsForDoc documents).
      .catch(() => {})
  }, [acId, itemType])

  useFocusEffect(useCallback(() => { reload() }, [reload]))

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') reload()
    })
    return () => sub.remove()
  }, [reload])

  useEffect(() => {
    if (!acId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    // Debounced: filing several items at once (addManyToFolder) would
    // otherwise fire one reload per row.
    const debounced = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(reload, 400)
    }
    const channel = supabase
      .channel(`shared-highlights:${itemType}:${acId}`)
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'synced_folder_items' },
          debounced)
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [acId, itemType, reload])
}
