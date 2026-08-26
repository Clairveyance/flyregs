import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react'
import { AppState } from 'react-native'
import { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { initRevenueCat, getSubscriptionStatus, logOutRevenueCat, syncEntitlements } from '@/lib/revenuecat'
import { applyRemoteSyncPreference, claimLocalDataForSignedOutUser } from '@/lib/sync'
import { claimDeviceIfMismatched } from '@/lib/syncOwner'
import { getDeviceId } from '@/lib/deviceId'
import { loadCachedEntitlement, saveCachedEntitlement } from '@/lib/entitlementCache'
import type { AvatarOverride } from '@/lib/avatar'

interface AuthContextType {
  session: Session | null
  loading: boolean
  isPro: boolean
  setIsPro: (v: boolean) => void
  isPremium: boolean
  setIsPremium: (v: boolean) => void
  isUnlocked: boolean
  setIsUnlocked: (v: boolean) => void
  // Derived, not stored: Pro/Premium subscribers get everything Plus offers
  // included, without needing to separately own the Plus entitlement — see
  // PROJECT_NOTES/flyregs_decisions.md, "Plus/Pro/Premium is a superset
  // ladder, not siblings" (2026-07-24). Gate every Plus-tier feature
  // (Highlights, Notes, Bookmarks, Ref Packets, Print/Export, ACs/LOIs,
  // uncapped search) on this, never on raw isUnlocked -- otherwise a Pro/
  // Premium subscriber who never separately bought Plus would be missing
  // the content Pro's sync and Premium's sharing actually depend on.
  hasPlusAccess: boolean
  // Pro tier and above (Premium includes Pro per the same superset ladder --
  // see hasPlusAccess's own comment). Gate any feature that specifically
  // requires Pro (not satisfied by owning Plus alone) on this, e.g.
  // MagicLink's expand-and-navigate action (RC, 2026-07-31: "ML has to at
  // least be Pro tier" -- corrected off an earlier, wrong hasPlusAccess gate).
  hasProAccess: boolean
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
  const [isUnlocked, setIsUnlocked] = useState(false)
  const hasPlusAccess = isUnlocked || isPro || isPremium
  const hasProAccess = isPro || isPremium
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
        // Fast path, RC real-device report (B35): "everything in the app is
        // taking WAY TOO LONG to open... should not be dependent on
        // internet speed." This whole block used to stay behind `loading`
        // (which gates the ENTIRE app's render) until getSubscriptionStatus()
        // resolved -- a real RevenueCat network call with up to 3 retries
        // (300/600/900ms backoff) if it's slow. A poor connection could
        // genuinely stall every screen behind a spinner for several seconds.
        // A warm launch (this device has seen this account's tier before)
        // now unblocks `loading` IMMEDIATELY from the last-known cached
        // result -- see entitlementCache.ts's own comment for why trusting
        // a few-seconds-stale tier client-side is safe (every real gated
        // read is still enforced server-side, not by client trust). The
        // real network fetch below still always runs, in the background
        // now instead of blocking -- it corrects the UI (and the cache) the
        // moment it resolves, same as before for a genuinely first-time
        // launch (no cache yet, falls straight through to the original
        // blocking behavior).
        const cached = await loadCachedEntitlement(session.user.id)
        if (cached) {
          setIsPro(cached.isPro)
          setIsPremium(cached.isPremium)
          setIsUnlocked(cached.isUnlocked)
          setLoading(false)
        }
        try {
          // Must run before anything below reads or writes local-first
          // storage (folders/bookmarks/notes/recents/downloads/recent-
          // searches) -- see claimDeviceIfMismatched's own comment for why a
          // mismatch has to be resolved here, up front, rather than left to
          // each read/write call to discover independently. Passes email so
          // a same-person-different-backend-id case (see that function's
          // own comment -- the 2026-08-26 real-data-loss incident) can be
          // told apart from a genuine different person on this device.
          await claimDeviceIfMismatched(session.user.id, session.user.email)
          initRevenueCat(session.user.id)
          const status = await getSubscriptionStatus()
          setIsPro(status.isPro)
          setIsPremium(status.isPremium)
          setIsUnlocked(status.isUnlocked)
          saveCachedEntitlement(session.user.id, status)
          // Self-healing catch-up for user_entitlements (the DB-backed
          // tier-of-record behind every *_gated view/RPC -- see
          // gotcha_tier_gate_client_side_only.md), in case revenuecat-webhook
          // ever missed an event while the app was closed. Once per real
          // session-init only (not on every onAuthStateChange firing below --
          // that fires on token refreshes too, which don't need a re-sync).
          syncEntitlements()
          // The sync on/off preference lives on the account (user_metadata),
          // not just this device — reconcile so a device that's never toggled
          // it manually still picks up the same state (and pulls the account's
          // data down) the first time it opens with this account signed in.
          //
          // Was `if (status.isPremium)` -- wrong tier. "Back up & sync" itself
          // gates on isPro (hasProAccess = isPro || isPremium), confirmed in
          // saved.tsx/notes.tsx's own toggleSync comments -- a Premium-only
          // check here meant a Pro (non-Premium) user's cross-device
          // reconciliation never ran on launch at all, so a second device
          // never auto-picked up their sync state or pulled their data down.
          // Same isPro-vs-hasProAccess mismatch pattern already found and
          // fixed 14x elsewhere in this codebase (gotcha_gating_sweep_2026_
          // 08_14.md), caught here on a fresh read while tracing the B34
          // readiness sweep's sync-retry finding.
          if (status.isPro || status.isPremium) {
            applyRemoteSyncPreference(session.user.id, session.user.user_metadata?.sync_enabled)
          }
        } finally {
          // finally, not a trailing call -- claimDeviceIfMismatched already
          // catches its own errors and getSubscriptionStatus never throws,
          // but initRevenueCat's Purchases.configure() is an unguarded
          // native bridge call; `loading` must not get stuck true forever
          // on cold launch (the whole app renders behind this flag) if it
          // does throw. A no-op if the cache fast path above already
          // cleared it.
          setLoading(false)
        }
      } else {
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      setSession(session)
      if (session?.user) {
        // SIGNED_IN specifically (not TOKEN_REFRESHED, which fires roughly
        // hourly for an already-signed-in session and shouldn't re-block
        // anything) re-uses the same `loading` gate the cold-launch branch
        // above already holds the UI behind -- real bug, RC real-device
        // report: Face ID sign-in (biometricAuth.ts's signInWithBiometric,
        // which calls supabase.auth.setSession directly) landed on a screen
        // showing session=truthy but isPro/isPremium still at their
        // pre-fetch `false` defaults, because THIS branch never gated
        // anything on `loading` the way cold launch does -- and
        // auth.tsx's handleBiometricSignIn dismisses the sign-in screen on
        // the very next tick after setSession() resolves, giving the async
        // entitlement fetch below essentially no head start. `loading` is
        // already the established signal other screens correctly wait on
        // before trusting hasProAccess/isPro/isPremium (see
        // (tabs)/index.tsx's HobbsHeaderButton for existing precedent) --
        // extending it to cover this event is consistent with that, not a
        // new mechanism.
        if (event === 'SIGNED_IN') setLoading(true)
        // Same cache-first fast path as the session-restore branch above --
        // a returning account's last-known tier unblocks `loading`
        // immediately instead of waiting on a real RevenueCat round trip.
        if (event === 'SIGNED_IN') {
          const cached = await loadCachedEntitlement(session.user.id)
          if (cached) {
            setIsPro(cached.isPro)
            setIsPremium(cached.isPremium)
            setIsUnlocked(cached.isUnlocked)
            setLoading(false)
          }
        }
        try {
          // Same reasoning as the session-restore branch above, PLUS gated
          // to a genuine new sign-in only -- this whole handler also fires
          // on TOKEN_REFRESHED (roughly hourly for an already-signed-in
          // session, see this handler's own comment above), and there is no
          // legitimate reason to re-run a destructive device-ownership
          // check on every one of those. Re-running it needlessly is what
          // multiplied the exposure window for the 2026-08-26 real-data-
          // loss incident (claimDeviceIfMismatched's own comment has the
          // full story) -- narrowing this to SIGNED_IN doesn't fix that
          // root cause by itself, but there's no reason to run a
          // potentially-destructive check outside a real sign-in event
          // either.
          if (event === 'SIGNED_IN') await claimDeviceIfMismatched(session.user.id, session.user.email)
          initRevenueCat(session.user.id)
          const status = await getSubscriptionStatus()
          setIsPro(status.isPro)
          setIsPremium(status.isPremium)
          setIsUnlocked(status.isUnlocked)
          saveCachedEntitlement(session.user.id, status)
        } finally {
          // finally, not a trailing call -- if anything above threw
          // (claimDeviceIfMismatched already catches its own errors, but
          // initRevenueCat's Purchases.configure() is an unguarded native
          // bridge call), `loading` must not get stuck true forever for
          // this session; better to fall through to whatever isPro/
          // isPremium/isUnlocked already held than freeze every consumer
          // that correctly waits on this flag.
          if (event === 'SIGNED_IN') setLoading(false)
        }
      } else {
        setIsPro(false)
        setIsPremium(false)
        setIsUnlocked(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  // isPro/isPremium/isUnlocked above only ever refresh on session-restore
  // and onAuthStateChange (sign-in/out, and Supabase's own token-refresh
  // events, which fire roughly hourly) -- there is no foreground hook, and
  // nothing anywhere in the app calls Purchases.addCustomerInfoUpdateListener
  // either. A real subscription change (an Apple-side downgrade/lapse
  // processed while FlyRegs is merely backgrounded, not force-quit) leaves
  // every consumer of these three flags reading the PRE-change tier for as
  // long as the app stays alive and the JWT hasn't happened to refresh yet
  // -- up to about an hour. Individual screens have had to work around this
  // one at a time (saved.tsx's own serverFolderCap live RPC re-check, this
  // file's own comment on that fix explains the exact same staleness
  // window) rather than it being closed at the source. Closing it here
  // fixes every consumer at once, the moment the app is foregrounded again,
  // without waiting on a token refresh -- matching AircraftDowngradeGate's
  // own reasoning for never trusting a merely-cached isPremium read.
  //
  // A ref (not the `session` state closed over at mount) is load-bearing:
  // AppState's listener is registered once, and this codebase has already
  // been bitten once by a stale closure silently freezing behavior across
  // later state changes (see gotcha_stale_closure_runsearch.md) -- reading
  // session.user.id through a ref sidesteps that class of bug entirely
  // rather than re-relying on a dependency array to keep the closure fresh.
  const sessionUserIdRef = useRef<string | null>(null)
  useEffect(() => {
    sessionUserIdRef.current = session?.user?.id ?? null
  }, [session?.user?.id])

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return
      if (!sessionUserIdRef.current) return
      getSubscriptionStatus().then((status) => {
        // Session could have been signed out while this was in flight --
        // re-check rather than blindly applying a result that may no
        // longer belong to anyone.
        if (!sessionUserIdRef.current) return
        setIsPro(status.isPro)
        setIsPremium(status.isPremium)
        setIsUnlocked(status.isUnlocked)
        saveCachedEntitlement(sessionUserIdRef.current, status)
      })
    })
    return () => sub.remove()
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
    // Stamp this device's local data as belonging to the user who is leaving,
    // BEFORE the session goes away (we need their id). Local bookmarks/folders/
    // notes deliberately survive sign-out, so without this the next account to
    // sign in would find an unclaimed local store and back it up as its own --
    // see SYNC_OWNER_KEY in lib/sync.ts.
    const departingUserId = session?.user?.id
    if (departingUserId) {
      await claimLocalDataForSignedOutUser(departingUserId, session?.user?.email).catch(() => {})
    }
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    // Paid tiers require an account as part of the plan — signing out means
    // the paid entitlement isn't available again until signing back in.
    setIsPro(false)
    setIsPremium(false)
    setIsUnlocked(false)
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
        session, loading, isPro, setIsPro, isPremium, setIsPremium, isUnlocked, setIsUnlocked, hasPlusAccess, hasProAccess, signIn, signUp, resendConfirmation,
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
