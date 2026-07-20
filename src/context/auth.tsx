import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { initRevenueCat, getSubscriptionStatus, logOutRevenueCat } from '@/lib/revenuecat'
import { applyRemoteSyncPreference } from '@/lib/sync'
import { getDeviceId } from '@/lib/deviceId'
import type { AvatarOverride } from '@/lib/avatar'

interface AuthContextType {
  session: Session | null
  loading: boolean
  isPro: boolean
  setIsPro: (v: boolean) => void
  isPremium: boolean
  setIsPremium: (v: boolean) => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  resendConfirmation: (email: string) => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  signOut: () => Promise<void>
  // See AvatarOverride's own comment in lib/avatar.ts -- an instant,
  // same-session override of "my own" avatar so every screen agrees the
  // moment a photo/preset is picked, instead of each independently waiting
  // on a session refresh + network image re-fetch.
  avatarOverride: AvatarOverride | null
  setAvatarOverride: (uri: string | null, presetId: string | null) => void
  // Reverts to "no override" (defer back to session/cache-derived truth) --
  // distinct from setAvatarOverride(null, null), which means "explicitly
  // removed, show initials." Used to unwind an optimistic update if the
  // underlying network write (upload, preset select, remove) actually fails.
  clearAvatarOverride: () => void
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPro, setIsPro] = useState(false)
  const [isPremium, setIsPremium] = useState(false)
  const [avatarOverride, setAvatarOverrideState] = useState<AvatarOverride | null>(null)
  const setAvatarOverride = (uri: string | null, presetId: string | null) => setAvatarOverrideState({ uri, presetId })
  const clearAvatarOverride = () => setAvatarOverrideState(null)

  useEffect(() => {
    // Pro/Premium require an account as part of the plan (see paywall.tsx's
    // sign-in gate before any purchase) — so RevenueCat's appUserID is always
    // the FlyRegs account id, and subscription status is only ever checked
    // while signed in. Signing out means the paid entitlement isn't carried
    // forward until signing back in with that same account.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session)
      if (session?.user) {
        initRevenueCat(session.user.id)
        const status = await getSubscriptionStatus()
        setIsPro(status.isPro)
        setIsPremium(status.isPremium)
        // The sync on/off preference lives on the account (user_metadata),
        // not just this device — reconcile so a device that's never toggled
        // it manually still picks up the same state (and pulls the account's
        // data down) the first time it opens with this account signed in.
        if (status.isPremium) {
          applyRemoteSyncPreference(session.user.id, session.user.user_metadata?.sync_enabled)
        }
      }
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session)
      if (session?.user) {
        initRevenueCat(session.user.id)
        const status = await getSubscriptionStatus()
        setIsPro(status.isPro)
        setIsPremium(status.isPremium)
      } else {
        setIsPro(false)
        setIsPremium(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  const signUp = async (email: string, password: string) => {
    // Soft per-device rate limit on signups, to blunt fake-account spam --
    // enforced server-side via a SECURITY DEFINER function so it can't be
    // bypassed by just not calling it; the device ID itself is a locally
    // generated value, not a hard device identifier, so this is a deterrent
    // rather than a hard guarantee. See src/lib/deviceId.ts.
    const deviceId = await getDeviceId()
    const { data: allowed, error: rateLimitError } = await supabase.rpc('check_and_record_signup_attempt', {
      p_device_id: deviceId,
      p_max_per_hour: 3,
    })
    if (rateLimitError) throw rateLimitError
    if (!allowed) {
      throw new Error('Too many accounts created on this device recently. Please try again in an hour.')
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: 'https://flyregs.com/confirm' },
    })
    if (error) throw error
  }

  const resendConfirmation = async (email: string) => {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: 'https://flyregs.com/confirm' },
    })
    if (error) throw error
  }

  const requestPasswordReset = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://flyregs.com/reset-password',
    })
    if (error) throw error
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    // Paid tiers require an account as part of the plan — signing out means
    // the paid entitlement isn't available again until signing back in.
    setIsPro(false)
    setIsPremium(false)
    // Otherwise a different account signing in on this same device would
    // start out showing the PREVIOUS account's just-picked avatar override.
    setAvatarOverrideState(null)
    // Resets RevenueCat's own identity too -- without this, a subsequent
    // Restore Purchases tap (even while genuinely signed out) would still
    // resolve against the just-signed-out account's RevenueCat identity.
    await logOutRevenueCat()
  }

  return (
    <AuthContext.Provider
      value={{
        session, loading, isPro, setIsPro, isPremium, setIsPremium, signIn, signUp, resendConfirmation,
        requestPasswordReset, signOut,
        avatarOverride, setAvatarOverride, clearAvatarOverride,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
