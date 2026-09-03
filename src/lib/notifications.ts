import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'
import { supabase } from '@/lib/supabase'
import AsyncStorage from '@react-native-async-storage/async-storage'

// AC Update Alerts — Premium feature. Two layers are involved, and they're
// independent of each other:
//   1. The OS-level permission (the system "Allow Notifications?" dialog).
//      Once the user answers, only THEY can change it again, in the device's
//      own Settings app — we can never silently re-grant or force it.
//   2. This app's own "AC Update Alerts" preference, which controls whether
//      we register/keep an active push token for this user at all. Turning
//      it on requests the OS permission if needed; turning it off just tells
//      our backend to stop sending (soft-disable), it doesn't touch the OS
//      permission, which the user would still need to revoke themselves if
//      they want to fully block the app at the system level.

export type AlertPermissionState = 'granted' | 'denied' | 'undetermined'

export async function getAlertPermissionState(): Promise<AlertPermissionState> {
  if (Platform.OS === 'web') return 'denied'
  const { status } = await Notifications.getPermissionsAsync()
  return status as AlertPermissionState
}

// Requests the OS permission (if not already granted) and returns a live
// Expo push token. Throws PERMISSION_DENIED so callers can show the "enable
// it in Settings" messaging instead of silently leaving their toggle in a
// state that doesn't actually work. Shared by every push-preference toggle
// (AC Update Alerts, DailyReg, and any future one) -- the OS
// permission and the device's push token are the same thing regardless of
// which in-app preference the user is turning on.
async function getOrRequestPushToken(): Promise<string> {
  if (Platform.OS === 'web') throw new Error('Not supported on web')

  let { status } = await Notifications.getPermissionsAsync()
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync()
    status = req.status
  }
  if (status !== 'granted') {
    throw new Error('PERMISSION_DENIED')
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId
  const { data } = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined
  )
  return data
}

// RC (2026-08-29, real joint testing with Adriana, real Premium account):
// "Adriana was on Prem last night... should have received everything" --
// a real, non-tier-gated gap. Every push-consuming feature (collaboration
// invites, Duel challenges, AC Update Alerts, DailyReg/DailyWord) required
// the user to first find and flip ONE SPECIFIC settings toggle before this
// device could ever be registered for push at all -- a brand-new user (or
// anyone who'd never happened to visit that one toggle) had no working
// path to receive ANY of them, regardless of tier. Requesting push
// permission is not itself a paid feature or a per-content preference --
// it's the underlying device capability every one of those toggles has
// always silently depended on existing first. Called from context/auth.tsx
// on every real sign-in (mirrors claimDeviceIfMismatched's own trigger
// point) -- safe to call repeatedly: getOrRequestPushToken() only shows
// the real OS dialog once ever per device (iOS remembers the answer,
// requestPermissionsAsync() is a fast no-op re-read after that either way).
// Deliberately does NOT flip any of the per-feature `_enabled` columns --
// registering the device is not the same as opting into any specific
// content stream, so an existing value (or false, for a first-ever row)
// is always preserved rather than silently turned on.
/** Register this device's push token, but ONLY if the OS has already granted
 * permission -- so this can run on every app foreground without ever raising
 * the permission dialog outside a genuine sign-in.
 *
 * Why this exists: ensurePushTokenRegistered is called from exactly one place,
 * `if (event === 'SIGNED_IN')` in context/auth.tsx. A restored persisted
 * session does NOT raise SIGNED_IN, so on every cold launch after the first it
 * never runs again. Aircraft reminders and AD alerts have no in-app toggle at
 * all, so nothing else ever calls getOrRequestPushToken() for those users.
 *
 * The dead end that creates: decline the iOS prompt at first sign-in, later
 * turn FlyRegs notifications ON in iOS Settings -- and push_tokens still has
 * zero rows for you, forever. Every reminder and every AD alert is then a
 * silent no-op (the send scripts bail on `rows.length === 0`), with no control
 * anywhere in the app that would fix it. Same shape as the 2026-08-29 case
 * where a real user had no push_tokens row and simply received nothing. */
export async function ensurePushTokenRegisteredIfGranted(userId: string): Promise<void> {
  if (Platform.OS === 'web') return
  try {
    const { status } = await Notifications.getPermissionsAsync()
    if (status !== 'granted') return
  } catch {
    return
  }
  await ensurePushTokenRegistered(userId)
}

export async function ensurePushTokenRegistered(userId: string): Promise<void> {
  if (Platform.OS === 'web') return
  try {
    const token = await getOrRequestPushToken()
    // Claim this token exclusively for the signing-in user -- found in the
    // 2026-08-29 "built but inert" sweep: push_tokens' primary key is
    // (user_id, expo_push_token), which deliberately allows the SAME
    // physical device to be registered under different accounts over time,
    // but nothing ever deleted a PRIOR account's row for this token when a
    // new one signed in. signOut() (context/auth.tsx) now also proactively
    // unregisters on the way out, but this is the self-healing backstop for
    // whenever that's skipped entirely -- a force-quit, a crash, an old
    // build without the signOut fix yet. Without either, a departing
    // account's row stayed `enabled` indefinitely, and every send script
    // only ever looks up rows by user_id -- so a shared, resold, or
    // handed-down device kept receiving the PREVIOUS owner's AC-update/
    // DailyReg/DailyWord/duel/invite pushes after a new person signed in on
    // it. RC's own dual-account testing practice is exactly the kind of
    // activity that would trigger this.
    // A plain client-side delete here would silently affect ZERO rows --
    // push_tokens' RLS policy is `auth.uid() = user_id` for every command,
    // so a row belonging to a DIFFERENT user is invisible to this delete
    // before it ever runs. claim_push_token is a narrow SECURITY DEFINER
    // RPC that can only ever delete "some other user's row for this exact
    // token," never an arbitrary row -- see its own migration comment.
    await supabase.rpc('claim_push_token', { p_token: token })
    const { data: existing, error: existingError } = await supabase
      .from('push_tokens')
      .select('enabled, duel_notifications_enabled, reg_of_day_enabled, word_of_day_enabled')
      .eq('user_id', userId)
      .eq('expo_push_token', token)
      .maybeSingle()
    // supabase-js RESOLVES {data: null, error} on a network failure rather
    // than throwing, so without this a single blip on that read fell through
    // to the `?? false` defaults below and PERSISTED every notification
    // preference as OFF. This function runs on every app foreground via
    // ensurePushTokenRegisteredIfGranted, so that is a frequent path, and the
    // user is never told their alerts were turned off.
    if (existingError) return

    // No remote row means either a brand-new device or a sign-out/sign-in on
    // this one. Fall back to what this user last had, so the second case
    // restores their preferences instead of resetting them to off.
    let prior: PushPrefs | null = (existing as PushPrefs | null) ?? null
    if (!prior) {
      try {
        const cached = await AsyncStorage.getItem(PUSH_PREFS_KEY(userId))
        if (cached) prior = JSON.parse(cached) as PushPrefs
      } catch { /* a missing or corrupt cache just means the defaults below */ }
    }

    await supabase.from('push_tokens').upsert(
      {
        user_id: userId,
        expo_push_token: token,
        platform: Platform.OS,
        enabled: prior?.enabled ?? false,
        duel_notifications_enabled: prior?.duel_notifications_enabled ?? false,
        reg_of_day_enabled: prior?.reg_of_day_enabled ?? false,
        word_of_day_enabled: prior?.word_of_day_enabled ?? false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,expo_push_token' }
    )
  } catch (_) {
    // PERMISSION_DENIED, or any other failure -- this is a proactive
    // background call, not a user-initiated action, so there's no dialog
    // to show and nothing else to do; the existing per-feature toggles
    // remain the user-facing retry path if they later change their mind
    // in iOS Settings.
  }
}

// Called from context/auth.tsx's signOut(), before the session goes away --
// same bug this file's ensurePushTokenRegistered() comment describes, this
// is the immediate half of the fix rather than the self-healing one: a
// departing user's push_tokens row for THIS device is removed right away,
// instead of staying live (and `enabled`) until someone else happens to
// sign in on the same device later. Reads the token directly rather than
// through getOrRequestPushToken() so signing out never triggers the OS
// permission dialog -- if permission was never granted there's no token and
// nothing to clean up either way.
// Sign-out DELETEs this device's push_tokens row, which is correct -- a
// signed-out device should not keep a token registered. But the row is also
// where the four notification preferences live, so signing back in re-created
// it from the `?? false` defaults and every preference the user had turned on
// came back OFF, silently. Caching them locally lets the row be destroyed
// without destroying the settings.
//
// Namespaced by user id, so a different account signing in on this device
// cannot inherit the previous user's preferences -- which also means it does
// not belong in ALL_LOCAL_KEYS' cross-account wipe.
const PUSH_PREFS_KEY = (userId: string) => `@flyregs/push-prefs:${userId}`

type PushPrefs = {
  enabled: boolean
  duel_notifications_enabled: boolean
  reg_of_day_enabled: boolean
  word_of_day_enabled: boolean
}

export async function unregisterPushToken(userId: string): Promise<void> {
  if (Platform.OS === 'web') return
  try {
    const { status } = await Notifications.getPermissionsAsync()
    if (status !== 'granted') return
    const projectId = Constants.expoConfig?.extra?.eas?.projectId
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    )
    // Remember the preferences before the row that holds them is destroyed.
    const { data: prefs } = await supabase
      .from('push_tokens')
      .select('enabled, duel_notifications_enabled, reg_of_day_enabled, word_of_day_enabled')
      .eq('user_id', userId)
      .eq('expo_push_token', token)
      .maybeSingle()
    if (prefs) {
      await AsyncStorage.setItem(PUSH_PREFS_KEY(userId), JSON.stringify(prefs)).catch(() => {})
    }
    await supabase.from('push_tokens').delete().eq('user_id', userId).eq('expo_push_token', token)
  } catch (_) {
    // Best-effort, matching ensurePushTokenRegistered's own error handling --
    // ensurePushTokenRegistered's claim-on-register above still closes the
    // gap the next time anyone signs in on this device even if this fails.
  }
}

// Registers this device for push + upserts the token into Supabase tied to
// the signed-in user, marked enabled.
export async function enableAcUpdateAlerts(userId: string): Promise<void> {
  const token = await getOrRequestPushToken()
  const { error } = await supabase.from('push_tokens').upsert(
    {
      user_id: userId,
      expo_push_token: token,
      platform: Platform.OS,
      enabled: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,expo_push_token' }
  )
  if (error) throw error
}

// Soft-disable: keeps the token row (so re-enabling doesn't need a fresh
// permission prompt) but flags it so the send script skips it.
export async function disableAcUpdateAlerts(userId: string): Promise<void> {
  if (Platform.OS === 'web') return
  const { error } = await supabase
    .from('push_tokens')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
  if (error) throw error
}

export async function isAcUpdateAlertsEnabled(userId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false
  const { data, error } = await supabase
    .from('push_tokens')
    .select('enabled')
    .eq('user_id', userId)
    .eq('enabled', true)
    .limit(1)
  if (error) return false
  return (data?.length ?? 0) > 0
}

// ── DailyReg (Pro/Premium, opt-in) ────────────────────────────────────
// A separate toggle from AC Update Alerts -- both ride the same push_tokens
// row/device registration, but a user should be able to want one without the
// other (daily trivia vs. "my saved content changed"). Requires the base
// enableAcUpdateAlerts() to have run at least once for this device (that's
// what actually requests the OS permission and registers the push token);
// this just flips the extra column on an existing row.

export async function enableDailyReg(userId: string): Promise<void> {
  const token = await getOrRequestPushToken()

  // Preserve whatever the AC Update Alerts `enabled` flag already is on an
  // existing row (a user turning on DailyReg alone shouldn't silently
  // opt them into AC alerts too) -- only default it to false on a brand-new
  // row. upsert() can't express "leave this column alone on conflict, but
  // set it on insert" in one call, so this checks first.
  const { data: existing } = await supabase
    .from('push_tokens')
    .select('enabled')
    .eq('user_id', userId)
    .eq('expo_push_token', token)
    .maybeSingle()

  const { error } = await supabase.from('push_tokens').upsert(
    {
      user_id: userId,
      expo_push_token: token,
      platform: Platform.OS,
      enabled: existing?.enabled ?? false,
      reg_of_day_enabled: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,expo_push_token' }
  )
  if (error) throw error
}

export async function disableDailyReg(userId: string): Promise<void> {
  if (Platform.OS === 'web') return
  const { error } = await supabase
    .from('push_tokens')
    .update({ reg_of_day_enabled: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
  if (error) throw error
}

export async function isDailyRegEnabled(userId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false
  const { data, error } = await supabase
    .from('push_tokens')
    .select('reg_of_day_enabled')
    .eq('user_id', userId)
    .eq('reg_of_day_enabled', true)
    .limit(1)
  if (error) return false
  return (data?.length ?? 0) > 0
}

// P/CG deliberately excluded -- RC, 2026-08-02: "DailyReg is supposed to
// rotate through FAR, AIM, and AC. P/CGs aren't regs, they're just handy
// to have." (P/CG had been in the rotation pool since it was P/CG-only
// originally; broadened to include FAR/AIM/AC without ever actually
// dropping P/CG, until now.) get_reg_of_the_day() now only pools FAR/AIM
// (via study_facts) and AC (via advisory_circulars).
export type DailyRegSource = 'far' | 'aim' | 'ac'

export interface DailyReg {
  slug: string
  // null for non-Pro viewers -- get_reg_of_the_day() redacts both server-side
  // now (see gotcha_tier_gate_client_side_only.md); DailyRegCard already
  // shows its own locked-teaser UI when !isPro, so these should never
  // actually render in practice, but the type has to admit reality.
  term: string | null
  definition: string | null
  sourceType: DailyRegSource
}

// Maps a DailyReg's sourceType to its real detail-screen route.
export function dailyRegRoute(item: Pick<DailyReg, 'slug' | 'sourceType'>): string {
  return `/${item.sourceType}/${item.slug}`
}

// The reg this pick actually came from, formatted to stand on its own.
// RC: "when the DailyReg is expanded or pushed to devices, it needs to show
// the reg that it came from at the bottom, so user can see that (just like
// the fix we did for study cards)." No backend work needed --
// get_reg_of_the_day() already returns the citation as `slug` (study_facts
// .item_id for FAR/AIM, document_number for AC), it just was never shown.
//
// Deliberately fuller than study.tsx's own docNumber (which renders a bare
// "3-1-4" for AIM): a Study Mode card is already inside a deck whose type
// you picked, whereas this string has to make sense alone on a lock screen
// with no surrounding context.
export function dailyRegCitation(item: Pick<DailyReg, 'slug' | 'sourceType'>): string {
  switch (item.sourceType) {
    case 'far': return `14 CFR § ${item.slug}`
    case 'aim': return `AIM ${item.slug}`
    case 'ac': return `AC ${item.slug}`
  }
}

// The same rotation get_reg_of_the_day() drives for the daily push (see
// scripts/send-reg-of-day.mjs) -- reused here so Home can show today's pick
// inline regardless of whether the user has the push toggle on. Not gated
// by tier: the underlying content (P/CG, FAR, AIM) is freely browsable,
// this is just a discovery surface for something already free to read.
export async function getDailyReg(): Promise<DailyReg | null> {
  const { data, error } = await supabase.rpc('get_reg_of_the_day')
  if (error) throw error
  const row = data?.[0]
  return row ? { slug: row.slug, term: row.term, definition: row.definition, sourceType: row.source_type } : null
}

export interface WordOfTheDay {
  slug: string
  term: string
  // category='mnemonic' rows need has_pro_access() to read (matches
  // dictionary_terms_gated's own redaction and the mnemonic-specific Pro
  // paywall on the Dictionary detail screen) -- a genuinely HIGHER bar than
  // every other category's has_plus_access(). Real live leak found+fixed
  // 2026-08-19/20: get_word_of_the_day() used to redact everything at the
  // single Plus bar regardless of category, so a Plus-but-not-Pro viewer
  // whose daily pick happened to be one of the 52 real mnemonic rows in the
  // pool got the real Pro-gated text back, both here and in the DailyWord
  // push (scripts/send-word-of-day.mjs). DailyWordCard branches on this now
  // (not just hasPlusAccess) to show the correct paywall tier per day.
  category: string
  // null for non-Plus viewers, OR for a Plus-but-not-Pro viewer on a
  // mnemonic day -- get_word_of_the_day() redacts it server-side (see
  // gotcha_tier_gate_client_side_only.md and the category comment above).
  // DailyWordCard branches on this value itself, not just hasPlusAccess, so
  // it should never actually render null in practice, but the type has to
  // admit reality.
  definition: string | null
}

// Mirrors getDailyReg()'s pattern (own get_word_of_the_day() rotation
// function, same deterministic-by-date hash approach) but scoped only to
// dictionary_terms. RC first wanted this free for everyone (2026-08-01),
// then reconsidered the next day given the app's overall free/paid balance
// and asked to gate it (2026-08-02); the fetch itself stays ungated here,
// the UI-level lock is in DailyWordCard (src/app/dictionary/index.tsx).
//
// 2026-08-16 correction: the comment here used to claim this was "gated
// Plus+ same as DailyReg" -- checked live and that was wrong on its own
// terms. DailyReg is Pro-gated (has_pro_access() in get_reg_of_the_day());
// DailyWord is genuinely Plus-gated (has_plus_access() in
// get_word_of_the_day(), a lower tier). RC: "the push not. should gate to
// same tier that gets the DW itself" -- enableDailyWord below gates Plus,
// not copied blind from DailyReg's Pro gate.
export async function getWordOfTheDay(): Promise<WordOfTheDay | null> {
  const { data, error } = await supabase.rpc('get_word_of_the_day')
  if (error) throw error
  const row = data?.[0]
  return row ? { slug: row.slug, term: row.term, definition: row.definition, category: row.category } : null
}

// ── DailyWord (Plus/Pro/Premium, opt-in) ──────────────────────────────
// Same shape as DailyReg's toggle (own opt-in column on push_tokens,
// requires getOrRequestPushToken to have run once for this device), gated
// to whatever tier actually unlocks DailyWord's content -- Plus, not Pro.
// See getWordOfTheDay's own comment above for why that distinction matters
// here specifically (the account.tsx call site must check hasPlusAccess,
// not hasProAccess -- see BB-090 in flyregs_beta_bug_tracker.md for what
// happens when a toggle handler is copy-pasted with the wrong tier check).

export async function enableDailyWord(userId: string): Promise<void> {
  const token = await getOrRequestPushToken()

  const { data: existing } = await supabase
    .from('push_tokens')
    .select('enabled')
    .eq('user_id', userId)
    .eq('expo_push_token', token)
    .maybeSingle()

  const { error } = await supabase.from('push_tokens').upsert(
    {
      user_id: userId,
      expo_push_token: token,
      platform: Platform.OS,
      enabled: existing?.enabled ?? false,
      word_of_day_enabled: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,expo_push_token' }
  )
  if (error) throw error
}

export async function disableDailyWord(userId: string): Promise<void> {
  if (Platform.OS === 'web') return
  const { error } = await supabase
    .from('push_tokens')
    .update({ word_of_day_enabled: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
  if (error) throw error
}

export async function isDailyWordEnabled(userId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false
  const { data, error } = await supabase
    .from('push_tokens')
    .select('word_of_day_enabled')
    .eq('user_id', userId)
    .eq('word_of_day_enabled', true)
    .limit(1)
  if (error) return false
  return (data?.length ?? 0) > 0
}

// Duel notifications -- mirrors the DailyReg toggle exactly (own
// opt-in column on push_tokens, off by default, independent of the base
// AC Update Alerts `enabled` flag). Fires on: a challenge created against
// you, your challenge getting accepted, and a duel completing -- see
// sendDuelPush() in challenges.ts, called client-side right after the
// action that should trigger it (no server-side trigger/edge function --
// the acting client is already online, so this stays a plain RPC + direct
// Expo push call rather than a new deployed function).
export async function enableDuelNotifications(userId: string): Promise<void> {
  const token = await getOrRequestPushToken()
  const { data: existing } = await supabase
    .from('push_tokens')
    .select('enabled')
    .eq('user_id', userId)
    .eq('expo_push_token', token)
    .maybeSingle()

  const { error } = await supabase.from('push_tokens').upsert(
    {
      user_id: userId,
      expo_push_token: token,
      platform: Platform.OS,
      enabled: existing?.enabled ?? false,
      duel_notifications_enabled: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,expo_push_token' }
  )
  if (error) throw error
}

export async function disableDuelNotifications(userId: string): Promise<void> {
  if (Platform.OS === 'web') return
  const { error } = await supabase
    .from('push_tokens')
    .update({ duel_notifications_enabled: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
  if (error) throw error
}

export async function isDuelNotificationsEnabled(userId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false
  const { data, error } = await supabase
    .from('push_tokens')
    .select('duel_notifications_enabled')
    .eq('user_id', userId)
    .eq('duel_notifications_enabled', true)
    .limit(1)
  if (error) return false
  return (data?.length ?? 0) > 0
}

// Invite by Callsign (aircraft + folder) -- mirrors sendDuelPush's exact
// shape (own RPC that resolves the actor's callsign label server-side +
// direct Expo push call, no server-side trigger). RC (real device,
// 2026-08-15): a callsign invite already resolves to a real user server-side
// via inviteCollaboratorByCallsign, but used to fall back to the OS share
// sheet anyway -- "it shouldn't do that at all, with a callsign, that an
// inside-FR feature and should simply locate the user with that callsign and
// send them the invite." Deep-links through the same /join/[token] route
// link-based invites already use (see get_collaboration_invite_push_target's
// migration comment) rather than a new "pending invites" inbox. Lives here
// rather than in aircraftSharing.ts/sharedFolders.ts so both can call it
// without importing each other.
export async function sendCollaborationInvitePush(
  targetUserId: string,
  resourceType: 'aircraft' | 'folder',
  resourceLabel: string,
  token: string
): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('get_collaboration_invite_push_target', {
      p_target_user_id: targetUserId,
      p_resource_type: resourceType,
      p_resource_label: resourceLabel,
      p_token: token,
    })
    if (error) return
    const rows = (data ?? []).filter((r: any) => r?.expo_push_token)
    if (rows.length === 0) return
    await Promise.all(rows.map((row: any) =>
      fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          to: row.expo_push_token,
          sound: 'default',
          title: row.title,
          body: row.body,
          data: { type: 'collab-invite', token },
        }),
      }).catch(() => {})
    ))
  } catch (_) { /* best-effort */ }
}
