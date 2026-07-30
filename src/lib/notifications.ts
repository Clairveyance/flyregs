import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'
import { supabase } from '@/lib/supabase'

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
// (AC Update Alerts, Reg of the Day, and any future one) -- the OS
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

// ── Reg of the Day (Pro/Premium, opt-in) ────────────────────────────────────
// A separate toggle from AC Update Alerts -- both ride the same push_tokens
// row/device registration, but a user should be able to want one without the
// other (daily trivia vs. "my saved content changed"). Requires the base
// enableAcUpdateAlerts() to have run at least once for this device (that's
// what actually requests the OS permission and registers the push token);
// this just flips the extra column on an existing row.

export async function enableRegOfTheDay(userId: string): Promise<void> {
  const token = await getOrRequestPushToken()

  // Preserve whatever the AC Update Alerts `enabled` flag already is on an
  // existing row (a user turning on Reg of the Day alone shouldn't silently
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

export async function disableRegOfTheDay(userId: string): Promise<void> {
  if (Platform.OS === 'web') return
  const { error } = await supabase
    .from('push_tokens')
    .update({ reg_of_day_enabled: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
  if (error) throw error
}

export async function isRegOfTheDayEnabled(userId: string): Promise<boolean> {
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

// Duel notifications -- mirrors the Reg of the Day toggle exactly (own
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
