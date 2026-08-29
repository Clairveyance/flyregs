import { useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import * as Linking from 'expo-linking'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'
import { markJustConfirmed } from '@/lib/justConfirmed'

// Landing screen for flyregs://confirm -- reached after tapping the
// confirmation-email link.
//
// 2026-08-29: the email link now points at the website's hand-off page with
// ?token_hash=...&type=signup -- NOT at Supabase's own {{ .ConfirmationURL }}
// (the old raw /auth/v1/verify link). That raw link is single-use and gets
// consumed by the FIRST GET from ANYONE -- an email security scanner or
// link-preview fetch that visits it before the real user taps kills it
// before they ever see it, the exact same failure mode reset-password.tsx's
// own comment already documented and fixed for password recovery. This
// screen now calls verifyOtp() itself (same as reset-password.tsx), which
// both confirms the account AND automatically establishes this client's own
// session -- confirmed live before shipping this: verifyOtp's returned
// session is NOT just data to hand to setSession, the supabase-js client
// sets it as its own active session internally, which is what lets
// context/auth.tsx's onAuthStateChange 'SIGNED_IN' handler pick it up
// naturally (entitlement sync, push registration, device-ownership claim --
// all the same real sign-in machinery a password sign-in already gets).
// Falls back to the old "please sign in" state if the token is missing or
// invalid (e.g. an already-used link, or a genuinely malformed one).
//
// A Universal Link tap bypasses the website hand-off page's own JS entirely
// (iOS opens the app directly on https://flyregs.com/confirm?token_hash=...,
// exactly as the email link itself points) -- useLocalSearchParams should
// see the query string in that case too, but a raw parse of the incoming
// URL (query OR hash) is kept as a fallback for any path that doesn't.
export default function ConfirmScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const { token_hash, type } = useLocalSearchParams<{ token_hash?: string; type?: string }>()
  const incomingUrl = Linking.useURL()
  const [state, setState] = useState<'working' | 'signedIn' | 'needsSignIn'>('working')

  useEffect(() => {
    let hash = token_hash
    let verifyType = type
    if (typeof hash !== 'string' && incomingUrl) {
      const hashIdx = incomingUrl.indexOf('#')
      const queryIdx = incomingUrl.indexOf('?')
      const paramString = hashIdx !== -1 ? incomingUrl.slice(hashIdx + 1) : queryIdx !== -1 ? incomingUrl.slice(queryIdx + 1) : ''
      const params = new URLSearchParams(paramString)
      hash = params.get('token_hash') ?? undefined
      verifyType = (params.get('type') as typeof verifyType) ?? undefined
    }
    if (typeof hash !== 'string') {
      setState('needsSignIn')
      return
    }
    supabase.auth.verifyOtp({ token_hash: hash, type: (verifyType as 'signup') ?? 'signup' }).then(({ error }) => {
      if (error) {
        setState('needsSignIn')
        return
      }
      markJustConfirmed()
      setState('signedIn')
      // dismissTo (not replace) -- if the "Check Your Email" modal (auth.tsx,
      // presentation: 'modal') is still presented from before the app was
      // backgrounded to tap the email link, replace() only swaps the screen
      // underneath it, leaving that modal on top and requiring the user to
      // manually close it to reach the Home screen it's now hiding.
      // dismissTo collapses any presented modal/pushed screens on the way to
      // the target, landing directly on Home either way.
      setTimeout(() => router.dismissTo('/'), 900)
    })
  }, [token_hash, type, incomingUrl])

  if (state === 'working') {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
        <ActivityIndicator size="large" color={tokens.blu} />
      </View>
    )
  }

  if (state === 'signedIn') {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
        <Icon name="checkmark.seal.fill" size={fs(44)} color={tokens.gold} />
        <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>Welcome to FlyRegs</Text>
      </View>
    )
  }

  // 2026-08-29: this copy used to just say "Your email is verified, sign in"
  // -- a safe assumption under the OLD flow, where the raw {{ .ConfirmationURL
  // }} link confirmed the account on its very FIRST hit from anyone, so any
  // failure state necessarily meant an already-confirmed account (whoever hit
  // it first, scanner or real user, both confirmed it). Under the new
  // verifyOtp() flow, confirmation and this screen's own success are the SAME
  // event -- a failure here can genuinely mean the account was never
  // confirmed at all (a truly expired or malformed link), not just "already
  // confirmed, come sign in." Worded to cover both real cases rather than
  // asserting one that might not be true.
  return (
    <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
      <Icon name="exclamationmark.triangle.fill" size={fs(44)} color={tokens.amb} />
      <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>Link expired</Text>
      <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14), lineHeight: fs(14) * 1.43 }]}>
        This confirmation link is invalid or has expired. If you already tapped it once, try signing in — otherwise, sign up again to get a new one.
      </Text>
      <Pressable style={[styles.btn, { backgroundColor: tokens.blu }]} onPress={() => router.dismissTo('/auth')}>
        <Text style={[styles.btnText, { fontSize: fs(15.5) }]}>Sign In</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', paddingHorizontal: 32, gap: 12 },
  title: { fontWeight: '700', textAlign: 'center', marginTop: 8 },
  // lineHeight NOT set here -- always overridden inline with fs(14) * 1.43
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  sub: { textAlign: 'center', maxWidth: 320 },
  btn: { marginTop: 16, paddingVertical: 14, paddingHorizontal: 28, borderRadius: 14 },
  btnText: { color: '#fff', fontWeight: '700' },
})
