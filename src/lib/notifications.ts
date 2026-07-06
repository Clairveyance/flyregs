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

// Registers this device for push + upserts the token into Supabase tied to
// the signed-in user, marked enabled. Throws if the OS permission is denied
// so the caller can show the "enable it in Settings" messaging instead of
// silently leaving the in-app toggle in a state that doesn't actually work.
export async function enableAcUpdateAlerts(userId: string): Promise<void> {
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

  const { error } = await supabase.from('push_tokens').upsert(
    {
      user_id: userId,
      expo_push_token: data,
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
