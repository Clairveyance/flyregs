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

// RC real-device report, 2026-08-26: upgraded Plus -> Pro, never signed
// out, and every local bookmark he'd added that same morning vanished.
// Root cause: this key used to store a BARE userId string, and
// claimDeviceIfMismatched below treated ANY stored-id-vs-current-session-id
// mismatch as proof of a genuinely different person on a shared device --
// which is exactly the real scenario this file exists to guard against
// (see the header comment above), but a raw auth.uid() isn't actually a
// stable "same person" signal: his account (and the one other real beta
// account, plus the shared preview account) had been recreated server-side
// on 2026-08-23/24 during an unrelated auth.users-restore incident, so his
// phone's already-stored id no longer matched his own account's new one --
// same real person, new backend id, zero user action. The guard couldn't
// tell that apart from a stranger's phone and wiped his local-only
// bookmarks (Back-up & Sync requires Pro, so there was never a cloud copy
// to restore from -- confirmed live, zero rows, before writing this fix).
//
// Fix: track email alongside the id. Two different ids under the SAME
// email are almost certainly the same person (an id changed server-side,
// not a device handed to someone else) -- re-claim the tag, never wipe.
// Only a genuine, confirmed email mismatch destroys data; an inconclusive
// comparison (either side missing an email -- always true for a tag
// written before this fix shipped) deliberately errs toward NOT wiping,
// since a false "wipe" here is irreversible and a false "don't wipe" just
// leaves this same check to run again next sign-in.
interface SyncOwner {
  userId: string
  email: string | null
}

async function getSyncOwnerRaw(): Promise<SyncOwner | null> {
  try {
    const raw = await AsyncStorage.getItem(SYNC_OWNER_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.userId === 'string') {
        return { userId: parsed.userId, email: typeof parsed.email === 'string' ? parsed.email : null }
      }
      return null
    } catch {
      // Pre-fix format: a bare userId string, written before this key
      // carried an email. No email on file for a tag in this shape.
      return { userId: raw, email: null }
    }
  } catch {
    return null
  }
}

export async function getSyncOwner(): Promise<string | null> {
  const owner = await getSyncOwnerRaw()
  return owner?.userId ?? null
}

export async function setSyncOwner(userId: string, email?: string | null): Promise<void> {
  try {
    // Never let a call that has no email to offer REGRESS an email this
    // device already captured for the SAME account. claimDeviceIfMismatched's
    // own same-user branch has always done this locally (`email ?? owner?.
    // email ?? null`, see its comment), but it was the only caller that did,
    // and it isn't the only caller: sync.ts's enableSync ends with a bare
    // setSyncOwner(userId) -- no email argument at all -- which used to
    // overwrite the tag as { userId, email: null }.
    //
    // That silently invalidated claimDeviceIfMismatched's own stated safety
    // argument for its inconclusive (missing-email) branch: "every claim from
    // here on carries an email, so this blind spot only exists once per
    // device." enableSync runs on every manual Back-up & Sync toggle AND from
    // applyRemoteSyncPreference on launch, so the blind spot was being
    // re-opened indefinitely, not once. Chain it left standing: user A's
    // session ends WITHOUT going through signOut() (expired/revoked refresh
    // token, "sign out all devices" from elsewhere) so
    // claimLocalDataForSignedOutUser never re-stamps the email; user B signs
    // in; claimDeviceIfMismatched hits the email-less inconclusive branch,
    // deliberately does NOT wipe, and re-tags A's still-present local data as
    // B's. Every localDataBelongsTo check now answers true for B -- so B not
    // only READS A's bookmarks/folders/notes, but enableSync's bulk push
    // uploads A's items, A's authored notes included, into B's cloud account.
    // That is exactly the leak SYNC_OWNER_KEY was created to stop (see
    // sync.ts's own header comment on it).
    //
    // Scoped to `existing.userId === userId` deliberately: on a genuine
    // handoff to a DIFFERENT account the stored email belongs to the previous
    // person and must never be inherited onto the new tag.
    let resolved = email ?? null
    if (!resolved) {
      const existing = await getSyncOwnerRaw()
      if (existing && existing.userId === userId) resolved = existing.email
    }
    const value: SyncOwner = { userId, email: resolved }
    await AsyncStorage.setItem(SYNC_OWNER_KEY, JSON.stringify(value))
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
// against. Compares by id only (not email) -- by the time any read runs,
// claimDeviceIfMismatched below has already resolved the tag for the
// CURRENT session, email match included, so a plain id comparison here is
// always checking against an already-reconciled tag.
export async function localDataBelongsTo(userId: string): Promise<boolean> {
  const owner = await getSyncOwnerRaw()
  return owner === null || owner.userId === userId
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
export async function claimDeviceIfMismatched(userId: string, email?: string | null): Promise<void> {
  try {
    const owner = await getSyncOwnerRaw()
    if (owner === null || owner.userId === userId) {
      // Also true on a first-ever claim or an exact-match no-op -- (re)stamp
      // the email either way, so a FUTURE id change for this same person
      // (another backend incident, however unlikely) has something to
      // confirm "same person" against next time, instead of starting from
      // the same email-less blind spot that caused this fix to be needed.
      // `email ?? owner?.email` -- this fires on more than just genuinely
      // new claims (e.g. onAuthStateChange re-firing SIGNED_IN on a plain
      // session restore, not just a fresh interactive sign-in), and some of
      // those callers may not always have session.user.email populated;
      // never let a call that's missing it regress an email this device
      // already captured on a previous, better-informed call.
      await setSyncOwner(userId, email ?? owner?.email ?? null)
      return
    }
    // Ids differ. Before treating this as a genuine different-person
    // device switch -- the only case this function should ever destroy
    // data for -- check whether it's actually the same person under a
    // changed backend id.
    if (owner.email && email) {
      // Both sides have a real email to compare -- a conclusive signal.
      if (owner.email.toLowerCase() === email.toLowerCase()) {
        await setSyncOwner(userId, email)
        return
      }
      await wipeAllLocalKeys()
      await setSyncOwner(userId, email)
      return
    }
    // Inconclusive -- missing an email on one or both sides, always true
    // for a tag written before this fix shipped. Deliberately does NOT
    // wipe: a false "wipe" here is irreversible (the real incident this
    // closes -- see this file's own header comment), while a false "don't
    // wipe" only means a genuinely-different person's very first sign-in on
    // a pre-fix-tagged device might see stale cached data until their own
    // claim overwrites it -- a real but narrow, self-limiting exposure
    // (every claim from here on carries an email, so this blind spot only
    // exists once per device, on whichever sign-in first runs this updated
    // logic). Re-tags to the new id/email either way so that one-time
    // window closes for good the moment this runs.
    await setSyncOwner(userId, email ?? null)
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
