import { useState } from 'react'
import {
  View,
  Text,
  Image,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '@/context/auth'
import { useTheme } from '@/context/theme'
import { Icon } from '@/components/Icon'
import { useFS } from '@/context/fontScale'

const WORDMARK_ASPECT = 1915 / 1428 // flyregs-wordmark.png width/height

type Mode = 'signin' | 'signup'

export default function AuthScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { signIn, signUp } = useAuth()
  const insets = useSafeAreaInsets()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !password) {
      Alert.alert('Missing fields', 'Please enter your email and password.')
      return
    }
    setLoading(true)
    try {
      if (mode === 'signin') {
        await signIn(trimmedEmail, password)
        router.dismiss()
      } else {
        await signUp(trimmedEmail, password)
        Alert.alert(
          'Check your email',
          'We sent a confirmation link. Verify your email, then sign in.',
          [{ text: 'OK', onPress: () => setMode('signin') }]
        )
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Something went wrong.')
    }
    setLoading(false)
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: tokens.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Modal handle row */}
      <View
        style={[
          styles.topRow,
          { paddingTop: Math.max(insets.top, 16), borderBottomColor: tokens.bdr },
        ]}
      >
        <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>
          {mode === 'signin' ? 'Sign In' : 'Create Account'}
        </Text>
        <Pressable onPress={() => router.dismiss()} hitSlop={8} style={styles.closeBtn}>
          <Icon name="xmark" size={18} color={tokens.t3} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.inner, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {/* FlyRegs wordmark */}
        <Image
          source={require('@/assets/images/flyregs-wordmark.png')}
          style={{ width: fs(135), height: fs(135) / WORDMARK_ASPECT, alignSelf: 'center', marginBottom: 4 }}
          resizeMode="contain"
        />

        <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(22) }]}>
          {mode === 'signin' ? 'Welcome back' : 'Create your account'}
        </Text>
        <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
          {mode === 'signin'
            ? 'Sign in to manage your account and subscription.'
            : "It's free to create an account — Pro and Premium features unlock once you subscribe."}
        </Text>

        {/* Email */}
        <View style={[styles.inputWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="envelope" size={16} color={tokens.t3} />
          <TextInput
            style={[styles.input, { color: tokens.t1, fontSize: fs(15) }]}
            placeholder="Email address"
            placeholderTextColor={tokens.t3}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
          />
        </View>

        {/* Password */}
        <View style={[styles.inputWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="lock" size={16} color={tokens.t3} />
          <TextInput
            style={[styles.input, { color: tokens.t1, fontSize: fs(15) }]}
            placeholder="Password"
            placeholderTextColor={tokens.t3}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete={mode === 'signin' ? 'password' : 'new-password'}
          />
        </View>

        {/* Submit */}
        <Pressable
          style={[
            styles.btn,
            { backgroundColor: tokens.blu },
            loading && styles.btnDisabled,
          ]}
          onPress={handleSubmit}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={[styles.btnText, { fontSize: fs(16) }]}>
              {mode === 'signin' ? 'Sign In' : 'Create Account'}
            </Text>
          )}
        </Pressable>

        {/* Toggle mode */}
        <Pressable onPress={() => setMode(mode === 'signin' ? 'signup' : 'signin')} style={styles.switchRow}>
          <Text style={[styles.switchText, { color: tokens.t3, fontSize: fs(14) }]}>
            {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          </Text>
          <Text style={[styles.switchLink, { color: tokens.blu, fontSize: fs(14) }]}>
            {mode === 'signin' ? 'Sign up' : 'Sign in'}
          </Text>
        </Pressable>

        <Text style={[styles.legal, { color: tokens.t4, fontSize: fs(11.5) }]}>
          By continuing you agree to our{' '}
          <Text style={{ color: tokens.blu }} onPress={() => router.push('/terms')}>
            Terms of Use
          </Text>{' '}
          and{' '}
          <Text style={{ color: tokens.blu }} onPress={() => router.push('/privacy')}>
            Privacy Policy
          </Text>
          .
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  modalTitle: { fontWeight: '600', fontSize: 16 },
  closeBtn: { position: 'absolute', right: 16, bottom: 12 },

  inner: { padding: 24, gap: 14 },
  headline: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  sub: { fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 4 },

  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 13,
    borderWidth: 1,
    paddingHorizontal: 14,
    height: 50,
  },
  input: { flex: 1, fontSize: 15 },

  btn: {
    borderRadius: 13,
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  switchRow: { flexDirection: 'row', justifyContent: 'center' },
  switchText: { fontSize: 14 },
  switchLink: { fontSize: 14, fontWeight: '600' },

  legal: { fontSize: 11.5, textAlign: 'center', lineHeight: 17 },
})
