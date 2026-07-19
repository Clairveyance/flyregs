import { useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'
import { markJustConfirmed } from '@/lib/justConfirmed'

// Landing screen for flyregs://confirm -- reached after tapping the
// confirmation-email link. Supabase confirms the account server-side BEFORE
// ever redirecting here, and (via the website hand-off page) hands us the
// fresh session's access_token/refresh_token as query params -- if present,
// sign the user straight in instead of making them type their password
// again right after they just created it. Falls back to the old "please
// sign in" state if the tokens are missing (e.g. an older email link, or the
// hand-off page couldn't parse them for some reason).
export default function ConfirmScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const { access_token, refresh_token } = useLocalSearchParams<{ access_token?: string; refresh_token?: string }>()
  const [state, setState] = useState<'working' | 'signedIn' | 'needsSignIn'>('working')

  useEffect(() => {
    if (typeof access_token !== 'string' || typeof refresh_token !== 'string') {
      setState('needsSignIn')
      return
    }
    supabase.auth.setSession({ access_token, refresh_token }).then(({ error }) => {
      if (error) {
        setState('needsSignIn')
        return
      }
      markJustConfirmed()
      setState('signedIn')
      setTimeout(() => router.replace('/'), 900)
    })
  }, [access_token, refresh_token])

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
        <Icon name="checkmark.seal.fill" size={44} color={tokens.gold} />
        <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>Welcome to FlyRegs</Text>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
      <Icon name="checkmark.seal.fill" size={44} color={tokens.gold} />
      <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>Email confirmed</Text>
      <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
        Your email is verified. Sign in to start using FlyRegs.
      </Text>
      <Pressable style={[styles.btn, { backgroundColor: tokens.blu }]} onPress={() => router.replace('/auth')}>
        <Text style={[styles.btnText, { fontSize: fs(15.5) }]}>Sign In</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', paddingHorizontal: 32, gap: 12 },
  title: { fontWeight: '700', textAlign: 'center', marginTop: 8 },
  sub: { textAlign: 'center', lineHeight: 20, maxWidth: 320 },
  btn: { marginTop: 16, paddingVertical: 14, paddingHorizontal: 28, borderRadius: 14 },
  btnText: { color: '#fff', fontWeight: '700' },
})
