import { useState, useEffect } from 'react'
import { View, Text, Image, TextInput, Pressable, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '@/context/auth'
import { useTheme } from '@/context/theme'
import { Icon } from '@/components/Icon'
import { useFS, useInputFS } from '@/context/fontScale'
import { markJustConfirmed } from '@/lib/justConfirmed'
import { useConfirm } from '@/components/ConfirmDialog'
import * as Biometric from '@/lib/biometricAuth'
import { supabase } from '@/lib/supabase'

const WORDMARK_ASPECT = 1915 / 1428 // flyregs-wordmark.png width/height

type Mode = 'signin' | 'signup' | 'check-email' | 'forgot' | 'forgot-sent'

// Cooldown between resend taps -- purely to stop accidental double-taps and
// obvious spam-clicking; Supabase enforces its own rate limit server-side
// regardless, this is just for a sane button state.
const RESEND_COOLDOWN_SECONDS = 30

export default function AuthScreen() {
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const ifs = useInputFS()
  const { signIn, signUp, resendConfirmation, requestPasswordReset } = useAuth()
  const insets = useSafeAreaInsets()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  // Standard field-level validation: a red-outlined field + a short message
  // right under it for "you left this blank," and a general (non-field)
  // banner for something the server rejected (wrong credentials, a signup
  // conflict, etc). Previously all of this went through a single generic
  // Alert.alert popup, which doesn't tell you WHICH field is the problem and
  // isn't the pattern users expect from basically every other app.
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  // BB-008/#422: Face ID/Touch ID as a faster alternative to typing
  // email+password -- see lib/biometricAuth.ts for the full design. null
  // means "not available/not enabled," so the button stays hidden by default
  // until this resolves (native-only; expo-local-authentication has no web
  // implementation, so this always stays null in the web preview).
  const [biometricEmail, setBiometricEmail] = useState<string | null>(null)
  const [biometricLabel, setBiometricLabel] = useState('Face ID')
  const [biometricBusy, setBiometricBusy] = useState(false)

  useEffect(() => {
    if (mode !== 'signin') return
    let cancelled = false
    ;(async () => {
      const enabled = await Biometric.isBiometricSignInEnabled()
      if (!enabled) return
      const [storedEmail, label] = await Promise.all([Biometric.getBiometricSignInEmail(), Biometric.biometricLabel()])
      if (cancelled) return
      setBiometricEmail(storedEmail)
      setBiometricLabel(label)
    })()
    return () => { cancelled = true }
  }, [mode])

  const clearErrors = () => { setEmailError(null); setPasswordError(null); setFormError(null) }

  const handleBiometricSignIn = async () => {
    setFormError(null)
    setBiometricBusy(true)
    try {
      const signedInEmail = await Biometric.signInWithBiometric()
      if (signedInEmail) router.dismiss()
      // null means the user cancelled the prompt -- stay on this screen with
      // no error, exactly like tapping away from a native biometric sheet.
    } catch {
      setBiometricEmail(null)
      setFormError('Your saved sign-in has expired. Please sign in with your password.')
    }
    setBiometricBusy(false)
  }

  // Offered once, right after a real password sign-in, only if biometric
  // hardware exists, it isn't already enabled, and the user hasn't already
  // said no once before (checked, not just assumed, each time -- a user who
  // enables it on one account and later signs into a different one should
  // still get asked, since enabling always overwrites to the current
  // session).
  const maybeOfferBiometricEnroll = async () => {
    if (!(await Biometric.isHardwareAvailable())) return
    if (await Biometric.isBiometricSignInEnabled()) return
    if (await Biometric.hasDeclinedBiometricPrompt()) return
    const { data } = await supabase.auth.getSession()
    const session = data.session
    if (!session) return
    const label = await Biometric.biometricLabel()
    confirm({
      title: `Sign in with ${label}?`,
      message: `Skip typing your email and password next time on this device.`,
      confirmLabel: 'Enable',
      cancelLabel: 'Not Now',
      onConfirm: async () => { await Biometric.enableBiometricSignIn(session) },
      onCancel: () => { Biometric.markBiometricPromptDeclined() },
    })
  }

  const handleSubmit = async () => {
    const trimmedEmail = email.trim()
    setFormError(null)
    const missingEmail = !trimmedEmail
    const missingPassword = !password
    setEmailError(missingEmail ? 'Enter your email address' : null)
    setPasswordError(missingPassword ? 'Enter your password' : null)
    if (missingEmail || missingPassword) return

    setLoading(true)
    try {
      if (mode === 'signin') {
        await signIn(trimmedEmail, password)
        await maybeOfferBiometricEnroll()
        router.dismiss()
      } else {
        await signUp(trimmedEmail, password)
        setMode('check-email')
        setResendCooldown(RESEND_COOLDOWN_SECONDS)
      }
    } catch (err: any) {
      const raw: string = err?.message ?? ''
      if (mode === 'signin' && /invalid.*(login|credentials)/i.test(raw)) {
        // Deliberately the same message whether the email doesn't exist or
        // the password is wrong -- distinguishing the two lets an attacker
        // discover which emails have accounts (email enumeration), which is
        // why Supabase's own error doesn't distinguish them either. Both
        // fields outlined red since there's no way to know which is at fault.
        setEmailError(' ')
        setPasswordError(' ')
        setFormError('Incorrect email or password. Please try again, or create an account if you don\'t have one yet.')
      } else {
        setFormError(raw || 'Something went wrong. Please try again.')
      }
    }
    setLoading(false)
  }

  const handleResend = async () => {
    if (resendCooldown > 0) return
    setLoading(true)
    try {
      await resendConfirmation(email.trim())
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
      confirm({ title: 'Sent', message: 'Check your email for a new confirmation link.', cancelLabel: null })
    } catch (err: any) {
      confirm({ title: 'Error', message: err?.message ?? 'Could not resend right now.', cancelLabel: null })
    }
    setLoading(false)
  }

  const handleForgotSubmit = async () => {
    const trimmedEmail = email.trim()
    setFormError(null)
    if (!trimmedEmail) {
      setEmailError('Enter your account email')
      return
    }
    setEmailError(null)
    setLoading(true)
    try {
      await requestPasswordReset(trimmedEmail)
      setMode('forgot-sent')
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
    } catch (err: any) {
      // Supabase doesn't reveal whether the email actually has an account --
      // resetPasswordForEmail resolves the same way either way, so an error
      // here is a real failure (network, rate limit), not "no such account."
      setFormError(err?.message ?? 'Could not send reset link right now.')
    }
    setLoading(false)
  }

  const handleResendReset = async () => {
    if (resendCooldown > 0) return
    setLoading(true)
    try {
      await requestPasswordReset(email.trim())
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
      confirm({ title: 'Sent', message: 'Check your email for a new reset link.', cancelLabel: null })
    } catch (err: any) {
      confirm({ title: 'Error', message: err?.message ?? 'Could not resend right now.', cancelLabel: null })
    }
    setLoading(false)
  }

  // Simple 1Hz countdown while a resend cooldown is active.
  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [resendCooldown > 0])

  // While sitting on "Check Your Email," silently retry sign-in every few
  // seconds -- covers the case where the confirmation link gets clicked on a
  // DIFFERENT device (e.g. signed up on the phone, confirmed from a desktop
  // email client) that has no way to push a live notice back to this one.
  // signIn() itself fails quietly with "Email not confirmed" until the
  // account actually is, so this just keeps trying until it isn't. Gives up
  // after 10 minutes so an abandoned screen doesn't poll forever.
  useEffect(() => {
    if (mode !== 'check-email') return
    const trimmedEmail = email.trim()
    let stopped = false
    const giveUpAt = Date.now() + 10 * 60 * 1000
    const t = setInterval(async () => {
      if (stopped || Date.now() > giveUpAt) { clearInterval(t); return }
      try {
        await signIn(trimmedEmail, password)
        if (stopped) return
        stopped = true
        clearInterval(t)
        markJustConfirmed()
        router.dismiss()
      } catch {
        // Still unconfirmed (or some other transient error) -- just try again next tick.
      }
    }, 4000)
    return () => { stopped = true; clearInterval(t) }
  }, [mode])

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
          {mode === 'signin' ? 'Sign In'
            : mode === 'signup' ? 'Create Account'
            : mode === 'forgot' ? 'Reset Password'
            : mode === 'forgot-sent' ? 'Check Your Email'
            : 'Check Your Email'}
        </Text>
        <Pressable onPress={() => router.dismiss()} hitSlop={8} style={styles.closeBtn}>
          <Icon name="xmark" size={fs(18)} color={tokens.t3} />
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

        {mode === 'check-email' ? (
          <>
            <Icon name="envelope" size={fs(40)} color={tokens.blu} style={{ alignSelf: 'center', marginBottom: 8 }} />
            <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(22) }]}>Check your email</Text>
            <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
              We sent a confirmation link to {email.trim()}. Tap it, then come back and sign in.
            </Text>

            <Pressable
              style={[
                styles.btn,
                { backgroundColor: tokens.blu },
                (loading || resendCooldown > 0) && styles.btnDisabled,
              ]}
              onPress={handleResend}
              disabled={loading || resendCooldown > 0}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={[styles.btnText, { fontSize: fs(16) }]}>
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Didn't get it? Resend"}
                </Text>
              )}
            </Pressable>

            <Pressable onPress={() => { clearErrors(); setMode('signin') }} style={styles.switchRow}>
              <Text style={[styles.switchLink, { color: tokens.blu, fontSize: fs(14) }]}>Back to sign in</Text>
            </Pressable>
          </>
        ) : mode === 'forgot' ? (
          <>
            <Icon name="lock" size={fs(40)} color={tokens.blu} style={{ alignSelf: 'center', marginBottom: 8 }} />
            <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(22) }]}>Reset your password</Text>
            <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
              Enter your account email and we'll send you a link to set a new password.
            </Text>

            <View style={[styles.inputWrap, { backgroundColor: tokens.inp, borderColor: emailError ? tokens.red : tokens.bdr2 }]}>
              <Icon name="envelope" size={fs(16)} color={tokens.t3} />
              <TextInput
                style={[styles.input, { color: tokens.t1, fontSize: ifs(15) }]}
                placeholder="Email address"
                placeholderTextColor={tokens.t3}
                value={email}
                onChangeText={(t) => { setEmail(t); setEmailError(null) }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
              />
            </View>
            {emailError?.trim() ? (
              <Text style={[styles.fieldError, { color: tokens.red, fontSize: fs(12.5) }]}>{emailError}</Text>
            ) : null}
            {formError ? (
              <Text style={[styles.formError, { color: tokens.red, fontSize: fs(13) }]}>{formError}</Text>
            ) : null}

            <Pressable
              style={[styles.btn, { backgroundColor: tokens.blu }, loading && styles.btnDisabled]}
              onPress={handleForgotSubmit}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={[styles.btnText, { fontSize: fs(16) }]}>Send Reset Link</Text>
              )}
            </Pressable>

            <Pressable onPress={() => { clearErrors(); setMode('signin') }} style={styles.switchRow}>
              <Text style={[styles.switchLink, { color: tokens.blu, fontSize: fs(14) }]}>Back to sign in</Text>
            </Pressable>
          </>
        ) : mode === 'forgot-sent' ? (
          <>
            <Icon name="envelope" size={fs(40)} color={tokens.blu} style={{ alignSelf: 'center', marginBottom: 8 }} />
            <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(22) }]}>Check your email</Text>
            <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
              If an account exists for {email.trim()}, we've sent a link to reset your password.
            </Text>

            <Pressable
              style={[
                styles.btn,
                { backgroundColor: tokens.blu },
                (loading || resendCooldown > 0) && styles.btnDisabled,
              ]}
              onPress={handleResendReset}
              disabled={loading || resendCooldown > 0}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={[styles.btnText, { fontSize: fs(16) }]}>
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Didn't get it? Resend"}
                </Text>
              )}
            </Pressable>

            <Pressable onPress={() => { clearErrors(); setMode('signin') }} style={styles.switchRow}>
              <Text style={[styles.switchLink, { color: tokens.blu, fontSize: fs(14) }]}>Back to sign in</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(22) }]}>
              {mode === 'signin' ? 'Welcome back' : 'Create your account'}
            </Text>
            <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
              {mode === 'signin'
                ? 'Sign in to manage your account and subscription.'
                : "It's free to create an account — Pro and Premium features unlock once you subscribe."}
            </Text>

            {mode === 'signin' && biometricEmail && (
              <>
                <Pressable
                  style={[styles.btn, styles.biometricBtn, { borderColor: tokens.blu }, biometricBusy && styles.btnDisabled]}
                  onPress={handleBiometricSignIn}
                  disabled={biometricBusy}
                >
                  {biometricBusy ? (
                    <ActivityIndicator color={tokens.blu} />
                  ) : (
                    <>
                      <Icon name="faceid" size={fs(18)} color={tokens.blu} />
                      <Text style={[styles.btnText, { color: tokens.blu, fontSize: fs(16) }]}>
                        Sign in as {biometricEmail}
                      </Text>
                    </>
                  )}
                </Pressable>
                <View style={styles.dividerRow}>
                  <View style={[styles.dividerLine, { backgroundColor: tokens.bdr }]} />
                  <Text style={[styles.dividerText, { color: tokens.t4, fontSize: fs(12) }]}>or</Text>
                  <View style={[styles.dividerLine, { backgroundColor: tokens.bdr }]} />
                </View>
              </>
            )}

            {/* Email */}
            <View style={[styles.inputWrap, { backgroundColor: tokens.inp, borderColor: emailError ? tokens.red : tokens.bdr2 }]}>
              <Icon name="envelope" size={fs(16)} color={tokens.t3} />
              <TextInput
                style={[styles.input, { color: tokens.t1, fontSize: ifs(15) }]}
                placeholder="Email address"
                placeholderTextColor={tokens.t3}
                value={email}
                onChangeText={(t) => { setEmail(t); setEmailError(null); setFormError(null) }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
              />
            </View>
            {emailError?.trim() ? (
              <Text style={[styles.fieldError, { color: tokens.red, fontSize: fs(12.5) }]}>{emailError}</Text>
            ) : null}

            {/* Password */}
            <View style={[styles.inputWrap, { backgroundColor: tokens.inp, borderColor: passwordError ? tokens.red : tokens.bdr2 }]}>
              <Icon name="lock" size={fs(16)} color={tokens.t3} />
              <TextInput
                style={[styles.input, { color: tokens.t1, fontSize: ifs(15) }]}
                placeholder="Password"
                placeholderTextColor={tokens.t3}
                value={password}
                onChangeText={(t) => { setPassword(t); setPasswordError(null); setFormError(null) }}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoComplete={mode === 'signin' ? 'password' : 'new-password'}
              />
              <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={8}>
                <Icon name={showPassword ? 'eye.slash' : 'eye'} size={fs(18)} color={tokens.t3} />
              </Pressable>
            </View>
            {passwordError?.trim() ? (
              <Text style={[styles.fieldError, { color: tokens.red, fontSize: fs(12.5) }]}>{passwordError}</Text>
            ) : null}
            {formError ? (
              <Text style={[styles.formError, { color: tokens.red, fontSize: fs(13) }]}>{formError}</Text>
            ) : null}

            {mode === 'signin' && (
              <Pressable onPress={() => { clearErrors(); setMode('forgot') }} style={styles.forgotRow} hitSlop={4}>
                <Text style={[styles.switchLink, { color: tokens.blu, fontSize: fs(13.5) }]}>Forgot password?</Text>
              </Pressable>
            )}

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
            <Pressable
              onPress={() => { clearErrors(); setMode(mode === 'signin' ? 'signup' : 'signin') }}
              style={styles.switchRow}
            >
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
          </>
        )}
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
  biometricBtn: { backgroundColor: 'transparent', borderWidth: 1.5, flexDirection: 'row', gap: 8 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 2 },
  dividerLine: { flex: 1, height: 1 },
  dividerText: { fontWeight: '600' },

  fieldError: { marginTop: -8, marginLeft: 4 },
  formError: { textAlign: 'center', lineHeight: 18, marginTop: 2 },
  forgotRow: { alignItems: 'flex-end', marginTop: -6 },
  switchRow: { flexDirection: 'row', justifyContent: 'center' },
  switchText: { fontSize: 14 },
  switchLink: { fontSize: 14, fontWeight: '600' },

  legal: { fontSize: 11.5, textAlign: 'center', lineHeight: 17 },
})
