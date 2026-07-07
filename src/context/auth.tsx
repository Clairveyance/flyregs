import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { initRevenueCat, getSubscriptionStatus } from '@/lib/revenuecat'
import { isSyncEnabled, pullAndMergeAll } from '@/lib/sync'

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
        // Converge with any changes made on other devices since this app was
        // last opened — the sync toggle itself only pulls when flipped on.
        if (status.isPremium && (await isSyncEnabled())) {
          pullAndMergeAll(session.user.id)
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
