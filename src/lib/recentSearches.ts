import AsyncStorage from '@react-native-async-storage/async-storage'
import { currentUserId, localDataBelongsTo } from '@/lib/syncOwner'

// Past SEARCH QUERIES the user has typed ("light gun signals", "runway
// marking") — distinct from the existing Recents tab, which tracks
// documents the user has VISITED, not what they typed to find them.
// Explicitly requested: "a user searches several things... bounce around
// the app... comes back to the search bar... the dropdown below it lists
// all the recently typed in searches... keeps user from having to type in
// the same search term over and over."
//
// `scope` keeps Home's SmartSearch history and Ask FlyRegs' own history
// separate (RC: AFR's search bar should get "a dropdown, similar to what we
// have in other searches boxes" -- same mechanism, not the same shared
// list). Short keyword terms ("91.119") and full natural-language questions
// ("what happens if I lose radio comm") are different enough query styles
// that mixing them in one dropdown would just be noise in both places.
// Defaults to Home's original, unscoped key so existing users' history
// isn't dropped by this change.
function keyFor(scope: string): string {
  return scope === 'default' ? '@flyregs/recent-searches' : `@flyregs/recent-searches:${scope}`
}
const MAX_RECENT_SEARCHES = 10

// Same account-mismatch guard as folders.ts's getFolders() -- see that
// function's own comment for the leak this closes. Defense-in-depth: see
// recents.ts's getRecents() for why this stays even with the device-level
// claim in context/auth.tsx.
//
// Wrapped exactly like bookmarks.ts / notes.ts / downloads.ts / recents.ts:
// this was the ONE local store whose JSON.parse was unguarded. A corrupt or
// non-array value under the key made this reject, and because every other
// function here routes through it, one bad byte took out add/remove as well
// -- so the search bar's dropdown would stay permanently broken with no way
// for the user to clear it. The Array.isArray check matters too: a value of
// the wrong SHAPE parses fine, then throws later on `.filter`, further from
// the cause.
export async function getRecentSearches(scope: string = 'default'): Promise<string[]> {
  try {
    const userId = await currentUserId()
    if (userId && !(await localDataBelongsTo(userId))) return []
    const raw = await AsyncStorage.getItem(keyFor(scope))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === 'string') : []
  } catch {
    return []
  }
}

// Case-insensitive de-dup that re-surfaces the ORIGINAL casing/spacing of
// the first time a query was typed, moved to the front — searching "Light
// Gun" again after already having searched "light gun" should bump the one
// entry to the top, not create a second near-identical row a user has to
// scan past.
export async function addRecentSearch(query: string, scope: string = 'default'): Promise<string[]> {
  const trimmed = query.trim()
  if (!trimmed) return getRecentSearches(scope)
  const existing = await getRecentSearches(scope)
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase())
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES)
  try {
    await AsyncStorage.setItem(keyFor(scope), JSON.stringify(next))
  } catch {
    // A full disk shouldn't make typing in the search bar throw.
  }
  return next
}

export async function removeRecentSearch(query: string, scope: string = 'default'): Promise<string[]> {
  const existing = await getRecentSearches(scope)
  const next = existing.filter((q) => q !== query)
  try {
    await AsyncStorage.setItem(keyFor(scope), JSON.stringify(next))
  } catch {
    return existing
  }
  return next
}

export async function clearRecentSearches(scope: string = 'default'): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(scope))
  } catch {
    // no-op
  }
}
