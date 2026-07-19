import { useState, useEffect, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Linking,
  Alert,
  Platform,
  KeyboardAvoidingView,
  Animated,
} from 'react-native'
import * as MailComposer from 'expo-mail-composer'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useReturnToMenu } from '@/context/drawer'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { useFS } from '@/context/fontScale'
import { SUPPORT_EMAIL, APP_NAME, APP_VERSION } from '@/lib/appInfo'

const CATEGORIES = [
  { key: 'bug', label: 'Report a bug', icon: 'questionmark.circle' },
  { key: 'idea', label: 'Suggest a feature', icon: 'sparkles' },
  { key: 'content', label: 'Content correction', icon: 'doc.text' },
  { key: 'other', label: 'Something else', icon: 'envelope' },
] as const

type CatKey = (typeof CATEGORIES)[number]['key']

export default function FeedbackScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session } = useAuth()
  const insets = useSafeAreaInsets()
  const backToMenu = useReturnToMenu()
  const [category, setCategory] = useState<CatKey>('idea')
  const [message, setMessage] = useState('')
  const [showSentToast, setShowSentToast] = useState(false)
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
      Alert.alert('Add a little more', 'Tell us what happened or what you have in mind.')
      return
    }
    const catLabel = CATEGORIES.find((c) => c.key === category)?.label ?? 'Feedback'
    const subject = `${APP_NAME} — ${catLabel}`
    const footer = `\n\n—\n${APP_NAME} v${APP_VERSION} · ${Platform.OS}${
      session?.user?.email ? ` · ${session.user.email}` : ''
    }`
    const body = trimmed + footer

    // MailComposer presents Mail as an in-app sheet (never fully exits the
    // app) and tells us whether the user actually hit Send -- Linking's
    // mailto: handoff could do neither, which is exactly what left users
    // stuck looking at a stale compose window with no idea if it sent.
    const available = await MailComposer.isAvailableAsync()
    if (!available) {
      const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
      Linking.openURL(url).catch(() =>
        Alert.alert('Could not open mail', `Please email us at ${SUPPORT_EMAIL}.`)
      )
      return
    }

    try {
      const result = await MailComposer.composeAsync({
        recipients: [SUPPORT_EMAIL],
        subject,
        body,
      })
      if (result.status === MailComposer.MailComposerStatus.SENT) {
        setMessage('')
        setShowSentToast(true)
      }
      // cancelled/saved: leave the draft text in place so they can try again.
    } catch {
      Alert.alert('Could not open mail', `Please email us at ${SUPPORT_EMAIL}.`)
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
          {CATEGORIES.map((c) => {
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
                <Icon name={c.icon} size={18} color={active ? tokens.blu : tokens.t2} />
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
            { backgroundColor: tokens.bg2, borderColor: tokens.bdr, color: tokens.t1, fontSize: fs(14.5) },
          ]}
          placeholder="Describe the bug, idea, or correction…"
          placeholderTextColor={tokens.t3}
          value={message}
          onChangeText={setMessage}
          multiline
          textAlignVertical="top"
          autoCapitalize="sentences"
        />

        <Pressable style={[styles.submit, { backgroundColor: tokens.blu }]} onPress={submit}>
          <Icon name="paperplane.fill" size={16} color="#fff" />
          <Text style={[styles.submitText, { fontSize: fs(15.5) }]}>Send</Text>
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
          <Icon name="checkmark.circle.fill" size={18} color={tokens.grn} />
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
