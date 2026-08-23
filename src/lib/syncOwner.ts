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

// Every local-first store that isn't per-user namespaced. Kept in one list
// so a genuine owner mismatch clears all of them together -- see
// claimDeviceIfMismatched below. (Deliberately excludes public/identical-
// for-everyone caches like the AC/FAR/AIM index or Home's What's New feed,
// and identityStatsCache/home-fleetsummary-cache, which are namespaced by
// uid at their own call sites instead.)
//
// '@flyregs/sync-enabled' (syncPush.ts's SYNC_ENABLED_KEY) belongs here too,
// found 2026-08-14 during a cross-account QA pass: it's a plain device-level
// flag, not a per-user cache, so it survived every mismatch wipe above it.
// Chain that exposed it -- User A turns on "Back up & sync" (sets this to
// 'true'), signs out. User B, a DIFFERENT real account who has NEVER touched
// sync, signs in on the same device. sync.ts's applyRemoteSyncPreference runs
// on every sign-in for a Premium/Pro account and reads this flag as "local";
// its `remoteSyncEnabled == null && local` branch reads that stale 'true' and
// silently calls supabase.auth.updateUser({ sync_enabled: true }) -- writing
// "sync enabled" into B's own REAL account metadata, permanently, with zero
// action from B. Confirmed live: a fresh disposable account picked up
// sync_enabled: true in its own user_metadata purely from a previous
// account's leftover local flag. Including this key here means a genuine
// mismatch resets it to "unset" (isSyncEnabled() reads null -> false) before
// applyRemoteSyncPreference ever runs for the new account, so that branch
// only fires when the SIGNED-IN account's own remote preference is what's
// actually null -- the honest "never configured, leave it off" case.
const ALL_LOCAL_KEYS = [
  '@flyregs/folders',
  '@flyregs/folder_items',
  '@flyregs/bookmarks',
  '@flyregs/notes',
  '@flyregs/recents',
  '@flyregs/downloads',
  '@flyregs/recent-searches',
  '@flyregs/recent-searches:afr',
  '@flyregs/sync-enabled',
]

// Shared by claimDeviceIfMismatched below and by account.tsx's account-
// deletion flow -- see wipeAllLocalDataForAccountDeletion's own comment for
// why deletion needs this same list but can't just call
// claimDeviceIfMismatched itself.
async function wipeAllLocalKeys(): Promise<void> {
  await Promise.all(ALL_LOCAL_KEYS.map((k) => AsyncStorage.removeItem(k)))
}

// Call once per confirmed session -- both a fresh sign-in and an app-launch
// session restore, see context/auth.tsx -- as early as possible, before any
// screen reads or writes local data. If this device's cache belongs to a
// DIFFERENT account (a real mismatch, not just an unset/never-claimed
// owner), every store above is wiped and the tag is reclaimed for `userId`
// right here.
//
// Why this has to happen up front, not just at read time: the per-read
// guards in folders.ts/bookmarks.ts/notes.ts (localDataBelongsTo) correctly
// hide a mismatched previous account's data from a read -- but a WRITE from
// the new account (e.g. createFolder, which reads that now-empty guarded
// array and appends to it, then writes the result back) has no way to tell
// "genuinely empty" apart from "emptied by the mismatch guard." Without this
// upfront claim, the new account's very first local write would silently
// overwrite -- not merge with -- the previous account's still-present real
// data, since the write path builds its result on top of the guarded (empty)
// view, not the actual underlying array. Resolving the mismatch once, here,
// means every later read AND write this session sees a real, consistent,
// already-reset local store instead of racing to discover it mid-write.
export async function claimDeviceIfMismatched(userId: string): Promise<void> {
  try {
    const owner = await getSyncOwner()
    if (owner === null || owner === userId) return
    await wipeAllLocalKeys()
    await setSyncOwner(userId)
  } catch {
    // Non-fatal -- the per-read guards in folders.ts/bookmarks.ts/notes.ts
    // still hide a mismatch from view even if this proactive clear fails;
    // worst case is a stale write-clobber risk, not a read-side leak.
  }
}

// Real production report, 2026-08-22: "I deleted my account and came back
// in the free account and it still shows the recents that I had when I was
// logged in." localDataBelongsTo()'s own contract is deliberately
// permissive for a SIGNED-OUT session ("signed-out browsing is
// unaffected") -- correct for the normal sign-out case (bookmarks/recents
// have to keep working with no account at all), but wrong for account
// DELETION specifically: the user explicitly asked to remove everything
// tied to them, not just their server-side rows. claimDeviceIfMismatched
// can't be reused as-is here -- it only wipes on a genuine OWNER MISMATCH
// against a new userId, and there's no new account to compare against yet
// at the moment of deletion (the caller is about to sign out, not sign
// into someone else). This wipes unconditionally and clears the owner tag
// entirely, so the device reads as "never claimed" afterward -- exactly
// the state a brand-new device would be in, and exactly what
// claimDeviceIfMismatched's own `owner === null` fast path already treats
// as safe to leave alone for whoever signs in next.
export async function wipeAllLocalDataForAccountDeletion(): Promise<void> {
  try {
    await wipeAllLocalKeys()
    await AsyncStorage.removeItem(SYNC_OWNER_KEY)
  } catch {
    // Non-fatal -- the account itself is already gone server-side by the
    // time this runs; a failed local wipe leaves stale data visible to
    // this same signed-out device only, not a network-reachable leak.
  }
}
