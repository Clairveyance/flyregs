import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'

// Which account this device's local data (@flyregs/bookmarks, /folders,
// /folder_items, /notes -- all global, no per-user namespacing) currently
// belongs to. Extracted from sync.ts into its own leaf module so the local
// READERS (folders.ts, bookmarks.ts, notes.ts) can consult it too -- sync.ts
// itself imports FROM those files, so they can never import back from
// sync.ts without a require cycle.
//
// Originally built to guard only the WRITE direction (enableSync's bulk
// push -- see sync.ts's own long comment on SYNC_OWNER_KEY): a mismatched
// owner meant "don't upload this to the new account." That left the READ
// direction wide open -- getFolders()/getBookmarks()/getNotes() served
// whatever was cached locally to ANY signed-in user with zero ownership
// check, so a shared device signing into a different account could still
// see (and, worse, act on -- rename, delete, invite from) a previous
// account's private folders and notes. Confirmed live, 2026-08-09, while
// verifying BB-102: RLS itself was correctly locked down -- this is a pure
// client-side stale-cache leak, not a network hole.
export const SYNC_OWNER_KEY = '@flyregs/sync-owner'

export async function getSyncOwner(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(SYNC_OWNER_KEY)
  } catch {
    return null
  }
}

export async function setSyncOwner(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(SYNC_OWNER_KEY, userId)
  } catch {
    // Non-fatal: a failed write just means the next check is treated as a
    // first-time/unknown owner, which is the conservative direction.
  }
}

// True when this device's local data either has no recorded owner yet (a
// fresh device, or one that's never had a different account sign out on it
// -- the normal, overwhelmingly common single-account case) or already
// belongs to `userId`. False only for a genuine mismatch: local data left
// behind by a DIFFERENT account. Signed-out browsing is unaffected --
// callers only run this check once they have a real userId to compare
// against.
export async function localDataBelongsTo(userId: string): Promise<boolean> {
  const owner = await getSyncOwner()
  return owner === null || owner === userId
}

// Shared by every local reader (folders.ts, bookmarks.ts, notes.ts) so the
// signed-in-user check lives in one place instead of three.
export async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession()
    return data.session?.user?.id ?? null
  } catch {
    return null
  }
}
