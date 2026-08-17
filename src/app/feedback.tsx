import { useState, useEffect, useRef } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Platform, KeyboardAvoidingView, Animated, Keyboard } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useReturnToMenu } from '@/context/drawer'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { useFS, useInputFS } from '@/context/fontScale'
import { SUPPORT_EMAIL, APP_VERSION } from '@/lib/appInfo'
import { useConfirm } from '@/components/ConfirmDialog'
import { supabase } from '@/lib/supabase'

const CATEGORIES = [
  { key: 'bug', label: 'Report a bug', icon: 'ladybug.fill' },
  { key: 'idea', label: 'Suggest a feature', icon: 'lightbulb.fill' },
  { key: 'content', label: 'Content correction', icon: 'pencil.and.outline' },
  { key: 'other', label: 'Something else', icon: 'ellipsis.bubble.fill' },
] as const

// Pro/Premium-only category -- RC, live: "we could consider adding a
// special 'Suggest Aircraft & Parts' feedback selection box in the menu,
// just for Pro and Premium subs ... might make it nicer, easier for those
// top tier subs to have a dedicated place to ask for an a/c or part to be
// added in the rare chance we don't have it." Kept as its own entry in
// this same screen/pipe (not a separate screen) rather than new
// infrastructure -- it's the identical "compose an email to support"
// mechanism every other category already uses, just a dedicated label +
// placeholder so a Pro/Premium user doesn't have to guess which bucket
// "please add the Zenith CH 750" belongs in.
const AIRCRAFT_PART_CATEGORY = { key: 'aircraft_part', label: 'Suggest Aircraft or Part', icon: 'airplane' } as const

type CatKey = (typeof CATEGORIES)[number]['key'] | typeof AIRCRAFT_PART_CATEGORY.key

// RC: "this default msg example should be unique to each category of
// feedback. Esp for the a/c owners - it should suggest/remind them what/how
// to send reqs for what they need." One shared generic placeholder across
// every category (aircraft_part excepted) gave no hint of what a GOOD
// report for that specific category looks like.
const MESSAGE_PLACEHOLDER: Record<CatKey, string> = {
  bug: 'What happened? Include what screen you were on, what you expected, and what happened instead.',
  idea: 'What would you like to see added or changed, and why would it help?',
  content: 'Which regulation, page, or section has the error — and what should it say instead?',
  other: "What's on your mind?",
  aircraft_part: 'Include the manufacturer, full model name, and type designator if you know it — e.g. "Cirrus SR22T G6" or "Van\'s RV-14" — so we can find the exact right one and get it added for you. Thank you for being a valued subscriber.',
}

export default function FeedbackScreen() {
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const ifs = useInputFS()
  const { session, hasProAccess } = useAuth()
  const insets = useSafeAreaInsets()
  const backToMenu = useReturnToMenu()
  const [category, setCategory] = useState<CatKey>('idea')
  const [message, setMessage] = useState('')
  const visibleCategories = hasProAccess ? [...CATEGORIES, AIRCRAFT_PART_CATEGORY] : CATEGORIES
  const [showSentToast, setShowSentToast] = useState(false)
  const [sending, setSending] = useState(false)
  const toastOpacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!showSentToast) return
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.delay(1400),
      Animated.timing(toastOpacity, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => setShowSentToast(false))
  }, [showSentToast])

  const submit = async () => {
    const trimmed = message.trim()
    if (trimmed.length < 4) {
      confirm({ title: 'Add a little more', message: 'Tell us what happened or what you have in mind.', cancelLabel: null })
      return
    }
    if (sending) return
    setSending(true)

    // Writes directly to Supabase (feedback_submissions), which a
    // server-side trigger relays to support@flyregs.com via Resend --
    // deliberately NOT dependent on the device's own mail app anymore.
    // The old expo-mail-composer/mailto handoff had no way to guarantee an
    // email actually left the device: on web, MailComposer.composeAsync()
    // can only ever report UNDETERMINED, never SENT; on native it falls
    // back to a raw Linking.openURL('mailto:...') for any device with no
    // account in Settings > Mail, which failed at least once for real (see
    // gotcha_feedback_pipeline_mailto_unreliable.md). This insert is the
    // ENTIRE send now -- durable the instant it succeeds, independent of
    // what happens next on the device.
    try {
      const { error } = await supabase.from('feedback_submissions').insert({
        category,
        message: trimmed,
        user_email: session?.user?.email ?? null,
        app_version: APP_VERSION,
        platform: Platform.OS,
      })
      if (error) throw error
      setMessage('')
      // RC, real device, sent 10 bug reports back-to-back: no on-screen
      // acknowledgment appeared for ANY of them. The toast below was
      // already there and firing correctly (all 10 really did arrive) --
      // the keyboard just never dismissed on submit, and stayed up over
      // this toast's low, near-bottom position (bottom: insets.bottom+24)
      // every single time, since nothing about tapping Send takes focus
      // off the still-active TextInput.
      Keyboard.dismiss()
      setShowSentToast(true)
    } catch {
      confirm({ title: 'Could not send', message: 'Please check your connection and try again.', cancelLabel: null })
    } finally {
      setSending(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: tokens.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <OverlayHeader title="Send Feedback" onBack={backToMenu} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <Text style={[styles.intro, { color: tokens.t2, fontSize: fs(14) }]}>
          We read every message. Pick a category and tell us what's on your mind.
        </Text>

        <Text style={[styles.label, { color: tokens.t3, fontSize: fs(11) }]}>CATEGORY</Text>
        <View style={styles.catGrid}>
          {visibleCategories.map((c) => {
            const active = category === c.key
            return (
              <Pressable
                key={c.key}
                style={[
                  styles.catCard,
                  {
                    backgroundColor: active ? tokens.bdim : tokens.bg2,
                    borderColor: active ? tokens.blu : tokens.bdr,
                  },
                ]}
                onPress={() => setCategory(c.key)}
              >
                <Icon name={c.icon} size={fs(18)} color={active ? tokens.blu : tokens.t2} />
                <Text style={[styles.catLabel, { color: active ? tokens.blu : tokens.t1, fontSize: fs(13) }]}>
                  {c.label}
                </Text>
              </Pressable>
            )
          })}
        </View>

        <Text style={[styles.label, { color: tokens.t3, marginTop: 18, fontSize: fs(11) }]}>MESSAGE</Text>
        <TextInput
          style={[
            styles.input,
            { backgroundColor: tokens.bg2, borderColor: tokens.bdr, color: tokens.t1, fontSize: ifs(14.5) },
          ]}
          placeholder={MESSAGE_PLACEHOLDER[category]}
          placeholderTextColor={tokens.t3}
          value={message}
          onChangeText={setMessage}
          multiline
          textAlignVertical="top"
          autoCapitalize="sentences"
        />

        <Pressable
          style={[styles.submit, { backgroundColor: tokens.blu, opacity: sending ? 0.6 : 1 }]}
          onPress={submit}
          disabled={sending}
        >
          <Icon name="paperplane.fill" size={fs(16)} color="#fff" />
          <Text style={[styles.submitText, { fontSize: fs(15.5) }]}>{sending ? 'Sending…' : 'Send'}</Text>
        </Pressable>

        <Text style={[styles.note, { color: tokens.t4, fontSize: fs(11.5) }]}>
          This sends to {SUPPORT_EMAIL}. We include your app version to help us debug.
        </Text>
      </ScrollView>

      {showSentToast && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.toast,
            { backgroundColor: tokens.bg2, borderColor: tokens.bdr, opacity: toastOpacity, bottom: insets.bottom + 24 },
          ]}
        >
          <Icon name="checkmark.circle.fill" size={fs(18)} color={tokens.grn} />
          <Text style={[styles.toastText, { color: tokens.t1, fontSize: fs(14.5) }]}>Sent!</Text>
        </Animated.View>
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16 },
  intro: { fontSize: 14, lineHeight: 21, marginBottom: 18, paddingHorizontal: 2 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8, paddingLeft: 2 },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  catCard: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 13,
  },
  catLabel: { fontSize: 13, fontWeight: '600', flex: 1 },
  input: {
    minHeight: 140,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    fontSize: 14.5,
    lineHeight: 21,
  },
  submit: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 13,
    height: 50,
    marginTop: 18,
  },
  submitText: { color: '#fff', fontSize: 15.5, fontWeight: '700' },
  note: { fontSize: 11.5, lineHeight: 17, textAlign: 'center', marginTop: 14 },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 6,
  },
  toastText: { fontWeight: '700' },
})
