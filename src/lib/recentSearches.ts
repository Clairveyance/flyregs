import AsyncStorage from '@react-native-async-storage/async-storage'

// Past SEARCH QUERIES the user has typed ("light gun signals", "runway
// marking") — distinct from the existing Recents tab, which tracks
// documents the user has VISITED, not what they typed to find them.
// Explicitly requested: "a user searches several things... bounce around
// the app... comes back to the search bar... the dropdown below it lists
// all the recently typed in searches... keeps user from having to type in
// the same search term over and over."
const RECENT_SEARCHES_KEY = '@flyregs/recent-searches'
const MAX_RECENT_SEARCHES = 10

export async function getRecentSearches(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(RECENT_SEARCHES_KEY)
  return raw ? JSON.parse(raw) : []
}

// Case-insensitive de-dup that re-surfaces the ORIGINAL casing/spacing of
// the first time a query was typed, moved to the front — searching "Light
// Gun" again after already having searched "light gun" should bump the one
// entry to the top, not create a second near-identical row a user has to
// scan past.
export async function addRecentSearch(query: string): Promise<string[]> {
  const trimmed = query.trim()
  if (!trimmed) return getRecentSearches()
  const existing = await getRecentSearches()
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase())
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES)
  await AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next))
  return next
}

export async function removeRecentSearch(query: string): Promise<string[]> {
  const existing = await getRecentSearches()
  const next = existing.filter((q) => q !== query)
  await AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next))
  return next
}

export async function clearRecentSearches(): Promise<void> {
  await AsyncStorage.removeItem(RECENT_SEARCHES_KEY)
}
