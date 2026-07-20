import { useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator, Alert, StyleSheet } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import * as Linking from 'expo-linking'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'

// Landing screen for flyregs://reset-password -- reached after tapping the
// "Reset password" email link. Supabase's redirect carries a recovery
// access_token/refresh_token, same shape as confirm.tsx's confirmation
// tokens (query params via the website hand-off page, or a raw hash
// fragment if a Universal Link tap skipped that page entirely) --
// setSession() with them establishes a short-lived recovery session that
// updateUser({ password }) is allowed to act on.
export default function ResetPasswordScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const { access_token, refresh_token } = useLocalSearchParams<{ access_token?: string; refresh_token?: string }>()
  const incomingUrl = Linking.useURL()
  const [state, setState] = useState<'working' | 'ready' | 'saving' | 'done' | 'invalid'>('working')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    let at = access_token
    let rt = refresh_token
    if ((typeof at !== 'string' || typeof rt !== 'string') && incomingUrl) {
      const hashIdx = incomingUrl.indexOf('#')
      if (hashIdx !== -1) {
        const hashParams = new URLSearchParams(incomingUrl.slice(hashIdx + 1))
        at = hashParams.get('access_token') ?? undefined
        rt = hashParams.get('refresh_token') ?? undefined
      }
    }
    if (typeof at !== 'string' || typeof rt !== 'string') {
      setState('invalid')
      return
    }
    supabase.auth.setSession({ access_token: at, refresh_token: rt }).then(({ error }) => {
      setState(error ? 'invalid' : 'ready')
    })
  }, [access_token, refresh_token, incomingUrl])

  const handleSave = async () => {
    if (password.length < 6) {
      Alert.alert('Password too short', 'Use at least 6 characters.')
      return
    }
    if (password !== confirmPassword) {
      Alert.alert("Passwords don't match", 'Make sure both fields match.')
      return
    }
    setState('saving')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      Alert.alert('Error', error.message)
      setState('ready')
      return
    }
    setState('done')
    setTimeout(() => router.replace('/'), 1200)
  }

  if (state === 'working') {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
        <ActivityIndicator size="large" color={tokens.blu} />
      </View>
    )
  }

  if (state === 'invalid') {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
        <Icon name="xmark.circle" size={44} color={tokens.red} />
        <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>Link expired</Text>
        <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
          This reset link is invalid or has expired. Request a new one from the sign-in screen.
        </Text>
        <Pressable style={[styles.btn, { backgroundColor: tokens.blu }]} onPress={() => router.replace('/auth')}>
          <Text style={[styles.btnText, { fontSize: fs(15.5) }]}>Back to Sign In</Text>
        </Pressable>
      </View>
    )
  }

  if (state === 'done') {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
        <Icon name="checkmark.seal.fill" size={44} color={tokens.gold} />
        <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>Password updated</Text>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
      <Icon name="lock" size={40} color={tokens.blu} />
      <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>Set a new password</Text>

      <View style={[styles.inputWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
        <Icon name="lock" size={16} color={tokens.t3} />
        <TextInput
          style={[styles.input, { color: tokens.t1, fontSize: fs(15) }]}
          placeholder="New password"
          placeholderTextColor={tokens.t3}
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          autoComplete="new-password"
        />
        <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={8}>
          <Icon name={showPassword ? 'eye.slash' : 'eye'} size={18} color={tokens.t3} />
        </Pressable>
      </View>

      <View style={[styles.inputWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
        <Icon name="lock" size={16} color={tokens.t3} />
        <TextInput
          style={[styles.input, { color: tokens.t1, fontSize: fs(15) }]}
          placeholder="Confirm password"
          placeholderTextColor={tokens.t3}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          autoComplete="new-password"
        />
      </View>

      <Pressable
        style={[styles.btn, { backgroundColor: tokens.blu }, state === 'saving' && styles.btnDisabled]}
        onPress={handleSave}
        disabled={state === 'saving'}
      >
        {state === 'saving' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={[styles.btnText, { fontSize: fs(15.5) }]}>Update Password</Text>
        )}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', paddingHorizontal: 32, gap: 12 },
  title: { fontWeight: '700', textAlign: 'center', marginTop: 8 },
  sub: { textAlign: 'center', lineHeight: 20, maxWidth: 320 },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 13,
    borderWidth: 1,
    paddingHorizontal: 14,
    height: 50,
    width: '100%',
    maxWidth: 340,
    marginTop: 4,
  },
  input: { flex: 1, fontSize: 15 },
  btn: {
    marginTop: 16,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 14,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '700' },
})
