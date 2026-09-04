import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Sentry from '@sentry/react-native'
import { supabase } from '@/lib/supabase'
import { isSyncEnabled } from '@/lib/syncPush'
import { getSubscriptionStatus } from '@/lib/revenuecat'
import { currentUserId } from '@/lib/syncOwner'

// Preferences that follow a user between devices when Back-up & Sync is on.
//
// RC, 2026-09-04: "yes, make the settings and selections travel too - IF bu/s
// is ON."
//
// WHY AN EXPLICIT ALLOW-LIST
// Every one of these is already an AsyncStorage key that the app reads at
// launch. It would be simpler to sync "everything in AsyncStorage" and much
// worse: that store also holds the corpus index caches (megabytes, and
// identical for everyone), the sync bookkeeping itself, and per-device facts
// like whether biometric sign-in was declined on THIS phone. Syncing those
// would be pointless at best and actively wrong at worst -- pushing one
// device's biometric state onto another is a bug, not a feature.
//
// So the list is deliberate and short, and adding to it is a one-line change
// with no migration (user_app_settings is key/value -- see its own migration
// for why).
export const SYNCED_SETTING_KEYS = [
  '@flyregs/thememode',              // Appearance: dark / light / auto
  '@flyregs/redshift',               // Red Shift
  '@flyregs/font-scale',             // Text size
  '@flyregs/badge-lifespan',         // How long NEW/UPD badges persist
  '@flyregs/study-session-size',     // Cards per Study session
  '@flyregs/study-reveal-direction', // Which face of a card shows first
  '@flyregs/study-filters',          // Study Mode's type/level/category picks
] as const

export type SyncedSettingKey = (typeof SYNCED_SETTING_KEYS)[number]

const isSynced = (k: string): k is SyncedSettingKey =>
  (SYNCED_SETTING_KEYS as readonly string[]).includes(k)

// Local listeners, so a pulled setting takes effect NOW rather than at the
// next launch. theme.tsx and fontScale.tsx hold their value in React state
// read once at mount; without this a setting pulled from the other device
// would sit in storage looking ignored until the app was restarted, which
// reads as "sync didn't work".
type Listener = (key: SyncedSettingKey, value: string | null) => void
const listeners = new Set<Listener>()

export function onSettingPulled(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// Same gate syncPush.ts uses, and for the same reason: the local flag only
// records that the user turned sync on at some point, so entitlement is
// re-checked on every push. `ok` is not optional -- an unreachable RevenueCat
// returns {false,false,false,ok:false}, which is indistinguishable from a
// real downgrade, and treating it as one silently stops syncing.
async function pushableUserId(): Promise<string | null> {
  if (!(await isSyncEnabled())) return null
  const { isPro, isPremium, ok } = await getSubscriptionStatus()
  if (!ok) return null
  if (!(isPro || isPremium)) return null
  return currentUserId()
}

// Pushes for the same KEY run in order, so two quick taps on the same toggle
// cannot land out of sequence and leave the older value winning. Different
// keys still push concurrently. Same shape as syncPush.ts's bookmark chain,
// which exists because that exact race lost a bookmark on the other device.
const chains = new Map<string, Promise<void>>()

function inOrder(key: string, work: () => Promise<void>): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(work, work)
  chains.set(key, next)
  next.finally(() => { if (chains.get(key) === next) chains.delete(key) })
  return next
}

/** Write a setting locally AND, if sync is on, push it.
 *
 * Local first and always: a preference must apply instantly and must keep
 * working signed out, offline, and on the free tier. The push is
 * fire-and-forget for the same reason every other push in this app is -- a
 * toggle must never wait on the network. */
export async function setSyncedSetting(key: SyncedSettingKey, value: string): Promise<void> {
  await AsyncStorage.setItem(key, value)
  void inOrder(key, async () => {
    try {
      const userId = await pushableUserId()
      if (!userId) return
      const { error } = await supabase.from('user_app_settings').upsert(
        { user_id: userId, key, value, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,key' },
      )
      if (error) {
        Sentry.captureException(error, {
          tags: { feature: 'settings_sync' }, extra: { key, stage: 'push' },
        })
      }
    } catch (e) {
      Sentry.captureException(e, { tags: { feature: 'settings_sync' }, extra: { key } })
    }
  })
}

/** Pull the account's settings and apply any that are newer than this device's.
 *
 * Called from sync.ts's pullAndMergeAll, so it runs wherever a sync runs.
 *
 * NO LAST-WRITE TIMESTAMP IS KEPT LOCALLY, on purpose. Storing one would mean
 * a second source of truth to keep in step with AsyncStorage, and the failure
 * mode is bad: a timestamp that drifts ahead of the value silently stops
 * accepting remote changes forever. Instead the remote row simply wins when
 * it differs -- correct because a local change writes through to the server
 * in the same breath (setSyncedSetting above), so a local value that differs
 * from the remote one is either older, or a push that has not landed yet and
 * will overwrite the remote row moments later anyway. */
export async function pullAppSettings(userId: string): Promise<void> {
  if (!(await isSyncEnabled())) return
  const { data, error } = await supabase
    .from('user_app_settings')
    .select('key, value')
    .eq('user_id', userId)
  // supabase-js RESOLVES {data: null, error} rather than throwing, so without
  // this an offline pull would look like "the account has no settings" and
  // the next push could write this device's defaults over the real ones.
  if (error || !data) return

  for (const row of data as { key: string; value: string | null }[]) {
    if (!isSynced(row.key)) continue      // ignore anything not on the list
    if (row.value == null) continue
    const current = await AsyncStorage.getItem(row.key)
    if (current === row.value) continue
    await AsyncStorage.setItem(row.key, row.value)
    for (const fn of listeners) {
      try { fn(row.key, row.value) } catch { /* one bad listener must not stop the rest */ }
    }
  }
}

/** Seed the account with this device's settings -- but only the ones the
 * account does not already have.
 *
 * Runs when Back-up & Sync is switched ON. The "only what is missing" part is
 * the whole design, and it took RC's own scenario to surface why:
 *
 *   "user has bu/s off. they have two devices, both running same account.
 *    they turn on bu/s > which device's info syncs to which? if they have
 *    other things on the other device, do those get over-written/erased?"
 *
 * Content answers that on its own: bookmarks, folders and notes are keyed by
 * id and merged, so two devices end up with the union and nothing is lost.
 * Settings cannot do that. There is no union of "dark" and "light" -- one has
 * to win.
 *
 * A blanket push made the LAST device to enable win, silently, which is the
 * worst possible rule: it is invisible, and it is decided by an ordering the
 * user has no reason to think matters. Measured before fixing it
 * (first_sync_conflict_test.ts): the phone enabled first with Light and
 * 180-day badges, the iPad enabled second, and the account came out Dark with
 * 14-day badges -- the phone's real preferences replaced by an iPad that had
 * never been configured.
 *
 * So: the FIRST device to turn sync on sets the baseline, every later device
 * adopts it, and from then on the most recent change anywhere wins. That rule
 * is explainable in one sentence, which matters as much as it being safe --
 * see SyncInfoPopup, which says exactly this to the user.
 *
 * A key the account has never held is still seeded from whichever device has
 * it, so a device that is the only one with Red Shift set does not lose it. */
export async function pushAllAppSettings(): Promise<void> {
  const userId = await pushableUserId()
  if (!userId) return

  const { data: existing, error } = await supabase
    .from('user_app_settings')
    .select('key')
    .eq('user_id', userId)
  // supabase-js RESOLVES {data: null, error} rather than throwing. Treating a
  // failed read as "the account has no settings" is exactly how this would
  // overwrite the other device's preferences on a flaky connection -- the
  // failure mode this whole function exists to prevent. Push nothing instead;
  // the pull that follows in enableSync will still bring the account's
  // settings down, and the next local change pushes normally.
  if (error || !existing) return
  const alreadySet = new Set((existing as { key: string }[]).map((r) => r.key))

  const rows: { user_id: string; key: string; value: string; updated_at: string }[] = []
  const now = new Date().toISOString()
  for (const key of SYNCED_SETTING_KEYS) {
    if (alreadySet.has(key)) continue
    const value = await AsyncStorage.getItem(key)
    if (value != null) rows.push({ user_id: userId, key, value, updated_at: now })
  }
  if (!rows.length) return
  const { error: writeError } = await supabase
    .from('user_app_settings')
    .upsert(rows, { onConflict: 'user_id,key' })
  if (writeError) {
    Sentry.captureException(writeError, {
      tags: { feature: 'settings_sync' }, extra: { stage: 'seed', count: rows.length },
    })
  }
}
