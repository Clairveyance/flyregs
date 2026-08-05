import { createContext, useCallback, useContext, useState } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Modal, TextInput } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'

// App-wide replacement for Alert.alert().
//
// Alert.alert() is a SILENT NO-OP on React Native Web: it runs, renders
// nothing, throws nothing, logs nothing. That produced a real user-visible
// bug (the "Keep this" buttons in the downgrade gate looked completely
// dead), and behind it a much bigger problem -- every confirm and error
// dialog in the product was invisible during Browser-pane QA, so web
// testing silently skipped every destructive-action confirmation in the
// app. Native was fine the whole time, which is exactly what made it easy
// to miss. See memory/gotcha_web_preview_alert_noop.md.
//
// Deliberately API-shaped like Alert.alert so migrating ~170 call sites is
// near-mechanical rather than a rewrite of each one: a title, an optional
// message, and up to two actions. Everything past that (async handler with
// a busy state, and an inline error slot instead of a SECOND dead alert on
// failure) is what the OS dialog couldn't do anyway.

export interface ConfirmOptions {
  title: string
  message?: string
  /** Defaults to 'OK'. */
  confirmLabel?: string
  /** Pass null for an informational dialog with no cancel button. */
  cancelLabel?: string | null
  /** Red confirm button, for deletes and anything irreversible. */
  destructive?: boolean
  /**
   * Require the user to TYPE this exact word before the confirm button does
   * anything. For irreversible, multi-record deletes only.
   *
   * Added 2026-08-05 after the downgrade gate deleted three real aircraft
   * from a stray tap during testing. The gate is a blocking modal that can
   * appear over ANY screen, and its primary action permanently destroys a
   * fleet -- so a tap already in flight toward something else lands on a
   * delete button that wasn't there a moment earlier. That's not a testing
   * artifact; it's the classic "modal stole my tap" failure, and a real
   * user hits it the same way. Typing makes an accidental trigger
   * impossible rather than merely unlikely.
   */
  requireTyped?: string
  /** May be async -- the dialog shows a spinner and stays open until it settles. */
  onConfirm?: () => void | Promise<void>
  onCancel?: () => void
}

const ConfirmContext = createContext<(opts: ConfirmOptions) => void>(() => {
  if (__DEV__) console.warn('useConfirm() called outside <ConfirmProvider>')
})

export function useConfirm() {
  return useContext(ConfirmContext)
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const { tokens } = useTheme()
  const fs = useFS()
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')

  const confirm = useCallback((o: ConfirmOptions) => {
    setError(null)
    setBusy(false)
    setTyped('')
    setOpts(o)
  }, [])

  const close = () => { setOpts(null); setBusy(false); setError(null); setTyped('') }

  const handleConfirm = async () => {
    if (!armed) return
    if (!opts?.onConfirm) { close(); return }
    setBusy(true)
    setError(null)
    try {
      await opts.onConfirm()
      close()
    } catch (e: any) {
      // Shown in place. The old pattern was to fire a second Alert.alert on
      // failure, which on web meant the action silently did nothing AND
      // silently failed to say so.
      setError(e?.message ?? 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  const showCancel = opts?.cancelLabel !== null
  // Nothing destructive is clickable until the word is typed exactly. A
  // dialog with no requireTyped is armed immediately, as before.
  const armed = !opts?.requireTyped || typed.trim().toUpperCase() === opts.requireTyped.toUpperCase()
  const confirmColor = !armed ? tokens.bdim : opts?.destructive ? tokens.red : tokens.blu

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal visible={!!opts} transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.scrim} onPress={showCancel && !busy ? close : undefined}>
          <Pressable style={[styles.card, { backgroundColor: tokens.bg2, borderColor: opts?.destructive ? tokens.red : tokens.bdr }]} onPress={() => {}}>
            {opts?.destructive && (
              <Icon name="exclamationmark.triangle" size={fs(24)} color={tokens.red} />
            )}
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(16.5) }]}>{opts?.title}</Text>
            {opts?.message ? (
              <Text style={[styles.message, { color: tokens.t3, fontSize: fs(13.5) }]}>{opts.message}</Text>
            ) : null}
            {error ? (
              <Text style={[styles.error, { color: tokens.red, fontSize: fs(12.5) }]}>{error}</Text>
            ) : null}
            {opts?.requireTyped && !busy ? (
              <View style={styles.typedWrap}>
                <Text style={[styles.typedHint, { color: tokens.t3, fontSize: fs(12.5) }]}>
                  Type {opts.requireTyped} to confirm
                </Text>
                <TextInput
                  value={typed}
                  onChangeText={setTyped}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder={opts.requireTyped}
                  placeholderTextColor={tokens.t4}
                  style={[styles.typedInput, { color: tokens.t1, borderColor: armed ? tokens.red : tokens.bdr, fontSize: fs(14.5) }]}
                />
              </View>
            ) : null}
            {busy ? (
              <ActivityIndicator color={tokens.t3} style={{ marginVertical: 14 }} />
            ) : (
              <View style={styles.actions}>
                <Pressable
                  style={[styles.btn, { backgroundColor: confirmColor }]}
                  onPress={handleConfirm}
                  disabled={!armed}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !armed }}
                >
                  <Text style={[styles.btnText, { fontSize: fs(14.5), opacity: armed ? 1 : 0.55 }]}>
                    {opts?.confirmLabel ?? 'OK'}
                  </Text>
                </Pressable>
                {showCancel && (
                  <Pressable onPress={() => { opts?.onCancel?.(); close() }} hitSlop={8} accessibilityRole="button">
                    <Text style={[styles.cancel, { color: tokens.t3, fontSize: fs(13.5) }]}>
                      {opts?.cancelLabel ?? 'Cancel'}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </ConfirmContext.Provider>
  )
}

const styles = StyleSheet.create({
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26, backgroundColor: 'rgba(0,0,0,0.7)' },
  card: { width: '100%', maxWidth: 360, borderRadius: 18, borderWidth: 1, padding: 22, alignItems: 'center', gap: 9 },
  title: { fontWeight: '700', textAlign: 'center' },
  message: { textAlign: 'center', lineHeight: 19 },
  error: { textAlign: 'center', marginTop: 2 },
  actions: { alignSelf: 'stretch', alignItems: 'center', gap: 12, marginTop: 6 },
  btn: { alignSelf: 'stretch', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700' },
  cancel: { fontWeight: '600' },
  typedWrap: { alignSelf: 'stretch', gap: 6, marginTop: 4 },
  typedHint: { textAlign: 'center' },
  typedInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, textAlign: 'center', fontWeight: '700' },
})
