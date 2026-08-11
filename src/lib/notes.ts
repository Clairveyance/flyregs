import AsyncStorage from '@react-native-async-storage/async-storage'
import { currentUserId, localDataBelongsTo } from '@/lib/syncOwner'

const NOTES_KEY = '@flyregs/notes'

export interface Note {
  id: string
  title: string
  body: string
  linked_ac: string | null
  updated_at: string
  /** Set only when this note was pulled down because a collaborator placed
   * it in a folder THIS account owns (see sync.ts's mergeNotes) -- absent
   * for every note this account authored itself. Mirrors FolderItem.
   * authorId exactly, and for the same reason: notes.tsx's save path must
   * route an edit to a tagged note through updateSharedNote (plain
   * update-by-id) instead of the normal syncPushNote upsert, which keys on
   * (user_id, id) and would create a duplicate row under this account's own
   * id rather than updating the original. */
  authorId?: string
}

export function makeNoteId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

// RC, 2026-08-11: "We shouldn't be shipping any test notes or any other
// example type data to any other account." A fresh install used to seed
// itself with 4 fake demo notes (id prefix "seed-") on first read, purely
// local placeholder content meant to show what a note looks like. The
// guard below always kept them from being pushed to a synced account, but
// that only stopped them from LEAKING -- it never stopped them from being
// shown at all, which is what actually caused real confusion: a beta
// tester's fresh account and RC's own account both display the exact same
// hardcoded "CFI checkride prep" / "Icing brief for students" text, which
// reads exactly like a real cross-account data leak even though it isn't
// one. No more first-run content at all now -- a genuinely empty account
// shows notes.tsx's own "No notes yet" empty state instead.
//
// isSeedNote() stays: any account whose local cache or synced_notes rows
// already have one of the old seed- ids (created before this change)
// still needs it excluded from sharing/sync, same as always -- this only
// stops NEW seed notes from ever being created, it doesn't retroactively
// touch what's already out there.
export function isSeedNote(id: string): boolean {
  return id.startsWith('seed-')
}

// Same account-mismatch guard as folders.ts's getFolders() -- see that
// function's own comment for the leak this closes. This store is likewise
// global/unnamespaced (see syncOwner.ts).
export async function getNotes(): Promise<Note[]> {
  try {
    const userId = await currentUserId()
    if (userId && !(await localDataBelongsTo(userId))) return []
    const raw = await AsyncStorage.getItem(NOTES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export async function saveNotes(notes: Note[]): Promise<void> {
  await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(notes))
}
