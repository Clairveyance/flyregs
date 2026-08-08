import { useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import * as Linking from 'expo-linking'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'
import { useConfirm } from '@/components/ConfirmDialog'

// Landing screen for flyregs://reset-password -- reached after tapping the
// "Reset password" email link. The email now points at the website's
// hand-off page with ?token_hash=...&type=recovery (query params via that
// page, or a raw hash fragment if a Universal Link tap skipped it entirely),
// NOT at Supabase's own /auth/v1/verify link (the old {{ .ConfirmationURL }}
// in the email template). That raw link is single-use and gets consumed by
// the first GET from ANYONE -- an email security scanner or link-preview
// fetch that visits it before the user taps kills it before the user ever
// sees it, reproduced live: the first curl request to a freshly generated
// link consumed it instantly, every request after got "otp_expired." Moving
// the actual exchange to verifyOtp() here means only this app's own JS ever
// consumes the token -- a scanner bot can't execute React Native.
export default function ResetPasswordScreen() {
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const ifs = useInputFS()
  const insets = useSafeAreaInsets()
  const { token_hash, type } = useLocalSearchParams<{ token_hash?: string; type?: string }>()
  const incomingUrl = Linking.useURL()
  const [state, setState] = useState<'working' | 'ready' | 'saving' | 'done' | 'invalid'>('working')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

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
      setState('invalid')
      return
    }
    supabase.auth.verifyOtp({ token_hash: hash, type: (verifyType as 'recovery') ?? 'recovery' }).then(({ error }) => {
      setState(error ? 'invalid' : 'ready')
    })
  }, [token_hash, type, incomingUrl])

  const handleSave = async () => {
    if (password.length < 6) {
      confirm({ title: 'Password too short', message: 'Use at least 6 characters.', cancelLabel: null })
      return
    }
    if (password !== confirmPassword) {
      confirm({ title: "Passwords don't match", message: 'Make sure both fields match.', cancelLabel: null })
      return
    }
    setState('saving')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      confirm({ title: 'Error', message: error.message, cancelLabel: null })
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
        <Icon name="xmark.circle" size={fs(44)} color={tokens.red} />
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
        <Icon name="checkmark.seal.fill" size={fs(44)} color={tokens.gold} />
        <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>Password updated</Text>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
      <Icon name="lock" size={fs(40)} color={tokens.blu} />
      <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>Set a new password</Text>

      <View style={[styles.inputWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
        <Icon name="lock" size={fs(16)} color={tokens.t3} />
        <TextInput
          style={[styles.input, { color: tokens.t1, fontSize: ifs(15) }]}
          placeholder="New password"
          placeholderTextColor={tokens.t3}
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          autoComplete="new-password"
        />
        <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={8}>
          <Icon name={showPassword ? 'eye.slash' : 'eye'} size={fs(18)} color={tokens.t3} />
        </Pressable>
      </View>

      <View style={[styles.inputWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
        <Icon name="lock" size={fs(16)} color={tokens.t3} />
        <TextInput
          style={[styles.input, { color: tokens.t1, fontSize: ifs(15) }]}
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
