import { createContext, useCallback, useContext, useRef, useState } from 'react'
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
   * Two-step confirm where the button MOVES between steps -- RC's design:
   * step 1 puts it at the bottom, step 2 at the top, so completing the
   * action requires physically touching a different part of the screen.
   * That defeats every realistic accident (finger bounce, double-tap, a
   * tap already travelling toward something else when a modal appears)
   * without making a deliberate user type anything.
   *
   * Automatically on for `destructive` actions -- pass false to opt out.
   */
  twoStep?: boolean
  /** Title shown on the SECOND step, if it should read differently. */
  finalTitle?: string
  /**
   * Require the user to TYPE this exact word. Reserved for deletes that are
   * BOTH multi-record AND reachable from a dialog the user never asked for
   * -- currently only the downgrade gate's fleet wipe. For anything the
   * user deliberately started, twoStep above is the proportionate
   * protection; typing is friction they did not earn. RC on the aircraft
   * case: "it isn't an enormous deal... they do have to re-enter their own
   * reminders, but there's only usually four or five of those per
   * Aircraft."
   */
  requireTyped?: string
  /**
   * A LIST of actions instead of a single confirm -- for the cases
   * Alert.alert was being used as a cheap action sheet (pick a time range,
   * invite as Viewer/Editor). Those were the worst web casualties: not just
   * an invisible confirm but an entire control that did nothing, which is
   * how the AD time-range "dropdown that won't open" reported itself.
   *
   * Mutually exclusive with confirmLabel/onConfirm/twoStep/requireTyped --
   * a picker has no single primary action to guard.
   */
  choices?: { label: string; destructive?: boolean; onPress: () => void | Promise<void> }[]
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
  const [step, setStep] = useState(1)
  // Brief arming delay on the final step so a fast second tap can't land on
  // the newly-positioned button before the user has seen it move.
  const [stepArmed, setStepArmed] = useState(true)
  // Bumped on every confirm() so a handler that opens a FOLLOW-UP dialog
  // isn't immediately closed by the caller's own cleanup. Without this,
  // `onConfirm: async () => { ...; confirm({ title: 'Failed' }) }` shows
  // nothing at all: the new dialog mounts, then the awaited close() from
  // the dialog that launched it wipes it. Account deletion's "Email
  // Support" follow-up is exactly that shape.
  const generation = useRef(0)

  const confirm = useCallback((o: ConfirmOptions) => {
    generation.current += 1
    setError(null)
    setBusy(false)
    setTyped('')
    setStep(1)
    setStepArmed(true)
    setOpts(o)
  }, [])

  const reset = () => { setOpts(null); setBusy(false); setError(null); setTyped(''); setStep(1); setStepArmed(true) }
  /** Closes only if no newer dialog opened while we were awaiting. */
  const closeIfCurrent = (gen: number) => { if (generation.current === gen) reset() }
  const close = () => reset()

  const handleConfirm = async () => {
    if (!armed) return
    // Step 1 only ADVANCES -- it never performs the action. The button then
    // renders somewhere else, so the second tap can't be muscle memory
    // from the first.
    if (wantsTwoStep && step === 1) {
      setStep(2)
      setStepArmed(false)
      setTimeout(() => setStepArmed(true), 400)
      return
    }
    if (!opts?.onConfirm) { close(); return }
    const gen = generation.current
    setBusy(true)
    setError(null)
    try {
      await opts.onConfirm()
      closeIfCurrent(gen)
    } catch (e: any) {
      // Shown in place. The old pattern was to fire a second Alert.alert on
      // failure, which on web meant the action silently did nothing AND
      // silently failed to say so.
      setError(e?.message ?? 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  const runChoice = async (c: NonNullable<ConfirmOptions['choices']>[number]) => {
    const gen = generation.current
    setBusy(true)
    setError(null)
    try {
      await c.onPress()
      closeIfCurrent(gen)
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  const showCancel = opts?.cancelLabel !== null
  // A picker never two-steps -- there's no single destructive primary to
  // guard, and each choice is already a deliberate, distinct tap.
  const wantsTwoStep = opts?.choices ? false : (opts?.twoStep ?? !!opts?.destructive)
  const onFinalStep = !wantsTwoStep || step === 2
  const typedOk = !opts?.requireTyped || typed.trim().toUpperCase() === opts.requireTyped.toUpperCase()
  const armed = onFinalStep ? typedOk && stepArmed : true
  const confirmColor = !armed ? tokens.bdim : opts?.destructive ? tokens.red : tokens.blu

  const confirmButton = (
    <Pressable
      style={[styles.btn, { backgroundColor: confirmColor }]}
      onPress={handleConfirm}
      disabled={!armed}
      accessibilityRole="button"
      accessibilityState={{ disabled: !armed }}
    >
      <Text style={[styles.btnText, { fontSize: fs(14.5), opacity: armed ? 1 : 0.55 }]}>
        {onFinalStep ? (opts?.confirmLabel ?? 'OK') : 'Continue'}
      </Text>
    </Pressable>
  )

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal visible={!!opts} transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.scrim} onPress={showCancel && !busy ? close : undefined}>
          <Pressable style={[styles.card, { backgroundColor: tokens.bg2, borderColor: opts?.destructive ? tokens.red : tokens.bdr }]} onPress={() => {}}>
            {opts?.destructive && (
              <Icon name="exclamationmark.triangle" size={fs(24)} color={tokens.red} />
            )}
            {/* RC's design: on the FINAL step the button jumps to the top,
                above the text, so confirming requires touching a different
                part of the screen than the tap that got you here. */}
            {onFinalStep && wantsTwoStep && !busy ? confirmButton : null}
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(16.5) }]}>
              {onFinalStep && wantsTwoStep ? (opts?.finalTitle ?? opts?.title) : opts?.title}
            </Text>
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
                {opts?.choices
                  ? opts.choices.map((c) => (
                      <Pressable
                        key={c.label}
                        style={[styles.btn, { backgroundColor: c.destructive ? tokens.red : tokens.blu }]}
                        onPress={() => runChoice(c)}
                        accessibilityRole="button"
                      >
                        <Text style={[styles.btnText, { fontSize: fs(14.5) }]}>{c.label}</Text>
                      </Pressable>
                    ))
                  : onFinalStep && wantsTwoStep ? null : confirmButton}
                {showCancel && (
                  <Pressable
                    style={[styles.cancelBtn, { borderColor: tokens.bdr }]}
                    onPress={() => { opts?.onCancel?.(); close() }}
                    accessibilityRole="button"
                  >
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
  // RC, real-device swipe/tap test (Equipment/Reminders, task #195): the
  // primary button and Cancel were close enough together (12px gap, Cancel
  // a bare text link with no real touch-target shape of its own) that a
  // fat-finger tap risked hitting the wrong one right after a swipe
  // gesture. gap widened and Cancel given its own bordered button shape --
  // both add real separation AND make Cancel's actual tappable area
  // obvious rather than implicit in a thin text label.
  actions: { alignSelf: 'stretch', alignItems: 'center', gap: 22, marginTop: 6 },
  btn: { alignSelf: 'stretch', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700' },
  cancelBtn: { alignSelf: 'stretch', borderRadius: 12, borderWidth: 1, paddingVertical: 11, alignItems: 'center' },
  cancel: { fontWeight: '600' },
  typedWrap: { alignSelf: 'stretch', gap: 6, marginTop: 4 },
  typedHint: { textAlign: 'center' },
  typedInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, textAlign: 'center', fontWeight: '700' },
})
