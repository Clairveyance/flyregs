import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

// expo-local-authentication dynamically imported (not top-level) inside
// each function below -- Sentry-confirmed, same root cause as
// BulkInviteContactPicker.tsx's own fix (see that file's comment):
// "Cannot find native module 'ExpoLocalAuthentication'," 29 occurrences
// since 2026-08-09, culprit account.tsx -- a static top-level import
// throws immediately at IMPORT time on a dev-client build that predates
// this dependency, and Expo Router evaluates every route file's import
// graph up front, so this fired regardless of whether biometric sign-in
// was ever actually used on a given screen. SecureStore is untouched --
// no evidence of the same failure, and it predates this Face ID feature.

// BB-008/#422 revisit -- RC's chosen scope: Face ID/Touch ID as a faster
// alternative to typing email+password on the sign-in screen, opt-in, one
// account per device (matches how most apps treat biometrics -- it unlocks
// THIS device's one saved sign-in, not a multi-account picker). Session
// persistence itself (staying signed in once already in) already works via
// Supabase's own refresh-token handling and needed no change -- this is
// purely about skipping the typing when NOT currently signed in.
//
// Web has no biometric hardware at all (expo-local-authentication's own
// .web.d.ts doesn't even export authenticateAsync) -- every function here
// is a safe no-op/false on web via the isHardwareAvailable() gate below, and
// the real flow can only be verified on a native device/simulator.

const ENABLED_KEY = '@flyregs/biometric-signin-enabled'
const DECLINED_KEY = '@flyregs/biometric-signin-declined'
const SESSION_KEY = 'flyregs_biometric_session'

interface StoredBiometricSession {
  access_token: string
  refresh_token: string
  email: string
}

export async function isHardwareAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') return false
  try {
    const LocalAuthentication = await import('expo-local-authentication')
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ])
    return hasHardware && isEnrolled
  } catch {
    return false
  }
}

// 'Face ID' vs 'Touch ID'/'fingerprint' copy depends on which the device
// actually supports -- iOS has no API to ask directly which one is enrolled,
// so FACIAL_RECOGNITION support is used as the signal (iPhones with Face ID
// report it; older iPhones/iPads with only Touch ID don't).
export async function biometricLabel(): Promise<string> {
  try {
    const LocalAuthentication = await import('expo-local-authentication')
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync()
    return types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION) ? 'Face ID' : 'Touch ID'
  } catch {
    return 'Face ID'
  }
}

export async function isBiometricSignInEnabled(): Promise<boolean> {
  try {
    const flag = await AsyncStorage.getItem(ENABLED_KEY)
    if (flag !== 'true') return false
    const stored = await SecureStore.getItemAsync(SESSION_KEY)
    return stored != null
  } catch {
    return false
  }
}

// Email to show on the sign-in screen's "Sign in as ___" button, or null if
// nothing is stored (never enabled, or cleared on disable/sign-out-elsewhere).
export async function getBiometricSignInEmail(): Promise<string | null> {
  try {
    const stored = await SecureStore.getItemAsync(SESSION_KEY)
    if (!stored) return null
    return (JSON.parse(stored) as StoredBiometricSession).email
  } catch {
    return null
  }
}

export async function hasDeclinedBiometricPrompt(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(DECLINED_KEY)) === 'true'
  } catch {
    return false
  }
}

export async function markBiometricPromptDeclined(): Promise<void> {
  await AsyncStorage.setItem(DECLINED_KEY, 'true').catch(() => {})
}

// Confirms identity via Face ID/Touch ID BEFORE storing anything -- storing a
// session under this device's biometric gate should require passing that
// gate once up front, the same way enabling it should feel as deliberate as
// using it later.
export async function enableBiometricSignIn(session: Session): Promise<boolean> {
  const LocalAuthentication = await import('expo-local-authentication')
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Confirm to enable biometric sign-in',
  })
  if (!result.success) return false
  const payload: StoredBiometricSession = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    email: session.user.email ?? '',
  }
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(payload))
  await AsyncStorage.setItem(ENABLED_KEY, 'true')
  await AsyncStorage.removeItem(DECLINED_KEY)
  return true
}

export async function disableBiometricSignIn(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(SESSION_KEY).catch(() => {}),
    AsyncStorage.setItem(ENABLED_KEY, 'false').catch(() => {}),
  ])
}

// Returns the signed-in email on success, null if the user cancelled the
// biometric prompt (not an error -- just fall back to the normal form),
// throws only for a genuine failure (expired/revoked refresh token) so the
// caller can clear the stale stored credential and show a real error.
export async function signInWithBiometric(): Promise<string | null> {
  const stored = await SecureStore.getItemAsync(SESSION_KEY)
  if (!stored) return null
  const { access_token, refresh_token, email } = JSON.parse(stored) as StoredBiometricSession

  const label = await biometricLabel()
  const LocalAuthentication = await import('expo-local-authentication')
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: `Sign in as ${email} with ${label}`,
  })
  if (!result.success) return null

  const { error } = await supabase.auth.setSession({ access_token, refresh_token })
  if (error) {
    // Stale/revoked refresh token -- the stored credential can't sign in
    // again on its own, so clear it rather than leaving a dead "Sign in with
    // Face ID" button that will fail the same way every time.
    await disableBiometricSignIn()
    throw error
  }
  return email
}

// The mismatch half of auth.tsx's maybeOfferBiometricEnroll, split out so
// EVERY real sign-in path can run it. Offering ENROLMENT is only appropriate
// right after a deliberate password sign-in, but clearing a DIFFERENT
// account's stored credential is required on all of them, and used to happen
// on exactly one: the password form. The email-confirmation link
// (confirm.tsx), the password-reset link (reset-password.tsx) and auth.tsx's
// own "check your email" poller all signed a user in while leaving the
// previous account's SecureStore credential in place.
//
// Two consequences on a shared device, both real: the sign-in screen renders
// "Sign in as <previous account's email>", disclosing an address the current
// user never entered; and signInWithBiometric() replays the STORED tokens via
// setSession() after only a device-level biometric check -- it never verifies
// that the person is that account -- so any enrolled finger/face on the
// device signs into the previous account.
//
// Deliberately does NOT gate on isHardwareAvailable(): the stale credential
// is worth clearing whether or not this device can currently offer biometrics.
export async function clearBiometricIfDifferentAccount(signedInEmail: string | null | undefined): Promise<void> {
  if (!signedInEmail) return
  const storedEmail = await getBiometricSignInEmail()
  if (!storedEmail) return
  if (storedEmail.toLowerCase() === signedInEmail.toLowerCase()) return
  await disableBiometricSignIn()
}
