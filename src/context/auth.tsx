import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { initRevenueCat, getSubscriptionStatus } from '@/lib/revenuecat'
import { applyRemoteSyncPreference } from '@/lib/sync'

interface AuthContextType {
  session: Session | null
  loading: boolean
  isPro: boolean
  setIsPro: (v: boolean) => void
  isPremium: boolean
  setIsPremium: (v: boolean) => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPro, setIsPro] = useState(false)
  const [isPremium, setIsPremium] = useState(false)

  useEffect(() => {
    // RevenueCat entitlements are tied to the device/App Store account, not
    // to a FlyRegs sign-in — FlyRegs doesn't require an account to purchase
    // or use Pro/Premium, so this must run regardless of session state, or
    // a paying customer who never signs in loses their unlock on every
    // restart.
    initRevenueCat(undefined)
    getSubscriptionStatus().then((status) => {
      setIsPro(status.isPro)
      setIsPremium(status.isPremium)
    })

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
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    // Pro/Premium is a device/App Store entitlement, not tied to the FlyRegs
    // account — signing out must not revoke a subscription the user paid for.
  }

  return (
    <AuthContext.Provider
      value={{ session, loading, isPro, setIsPro, isPremium, setIsPremium, signIn, signUp, signOut }}
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
