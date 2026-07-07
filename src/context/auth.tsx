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
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    setIsPro(false)
    setIsPremium(false)
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
