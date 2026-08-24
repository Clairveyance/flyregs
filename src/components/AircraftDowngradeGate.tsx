import { useEffect, useState, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Modal, TextInput, KeyboardAvoidingView, Platform } from 'react-native'
import { router, usePathname } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { Icon } from '@/components/Icon'
import { getFleetHiddenCount, getFleetVisibleCap, getOwnedAircraftOldestFirst, keepOnlyAircraft } from '@/lib/aircraftSharing'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// The Premium -> Pro landing pad, mounted at the root so it finds the user
// WHEREVER they are in the app.
//
// RC, 2026-08-05: "just make sure that this CTA will pop up for Prem
// downgrades to Pro - since this is not the actual place they will select
// and process a downgrade, this reminder has to display wherever they are,
// before the downgrade happens." That's the whole reason this isn't just a
// card on My Aircraft: a downgrade is processed in Apple's subscription
// settings, entirely outside this app, so there is no in-app moment we can
// attach it to. The app's only real opportunity is the next time it runs --
// and at that point the user could be anywhere, most likely NOT on My
// Aircraft, which is exactly where a card would have been sitting unseen.
//
// It's blocking on purpose. RC: "ALL their Prem a/c are 'locked out' until
// they make this choice, during the d/g process. and yes, this is a good
// protection in those cases of temp lapsed payment, etc." Nothing is
// deleted and nothing is auto-picked while it waits -- re-subscribing
// dismisses it with every aircraft untouched.
export function AircraftDowngradeGate() {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const { session } = useAuth()
  const pathname = usePathname()
  const [locked, setLocked] = useState<{ aircraftId: string; make: string; model: string; nickname: string | null }[]>([])
  // RC, 2026-08-22: "if a user DOES downgrade Prem>Pro, and have multiple
  // a/c, they must be notified first that they need to pick only one a/c
  // to take with them to Pro, and if d/g to Plus or Free, they must be
  // reminded that they will lose (complete delete) all their a/c's."
  // Pro's cap is 1 (pick-one, the flow below already built for this) --
  // but Plus/Free's cap is 0 (fleet_visible_cap(): "My Aircraft isn't part
  // of the tier"), where NO aircraft can ever be kept. Before this fix,
  // this component only ever knew "how many are hidden," not the real
  // cap -- so a Plus/Free downgrade showed the SAME "pick the one that
  // comes with you to Pro" copy (wrong: there is no Pro destination) and
  // let the user tap "Keep this" on exactly one, which -- at cap 0 -- is
  // STILL over cap and immediately re-triggers this same gate with that
  // one aircraft, forever. A real cap-0 downgrade could never resolve.
  const [cap, setCap] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  // The aircraft the user tapped "Keep this" on, awaiting confirmation.
  const [pending, setPending] = useState<{ aircraftId: string; make: string; model: string; nickname: string | null } | null>(null)
  // The cap-0 case: no single aircraft to pick, only "delete all N."
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const armed = typed.trim().toUpperCase() === 'DELETE'
  // Aircraft labels (nickname or make/model) can run long and get cut off
  // the same way FAR Part titles do -- same hook/card pair as
  // far/index.tsx's own long-press preview. Called unconditionally here
  // (before either early return below) per the rules of hooks; both
  // possible render branches share this one instance.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  // Keyed on the user id, not the raw `session` object -- confirmed live
  // (2026-08-18): supabase-js's onAuthStateChange fires SIGNED_IN/
  // INITIAL_SESSION repeatedly for the SAME already-signed-in user (same
  // token, same expires_at, no real change), which calls setSession with a
  // brand-new object every time. `check` used to depend on that whole
  // object, so every one of those no-op events produced a new `check`
  // identity, which retriggered the effect below and re-hit
  // getFleetHiddenCount() -- a real Supabase round trip -- on a loop, dozens
  // of times a minute, app-wide (this component is mounted at root), for as
  // long as the app stayed open. `check` never reads anything from `session`
  // except the truthy check, so the user id is the only part of it that
  // should ever matter here; a token refresh for the same person is not a
  // reason to re-run this.
  const userId = session?.user?.id ?? null
  const check = useCallback(async () => {
    if (!userId) { setLocked([]); return }
    try {
      // Server count first: it's the tier-of-record answer, so a client
      // whose RevenueCat read is momentarily stale can't skip the gate.
      // Deliberately NOT bailing out early on client-cached isPremium here
      // (a previous version did) -- that cache only refreshes on session
      // init or an auth-state-change event, never on app foreground, so a
      // user who downgrades in Settings while FlyRegs is merely
      // backgrounded (not force-quit) would keep reading isPremium=true
      // for as long as the app stays alive, silently skipping this exact
      // check on every single navigation. The RLS cap-gate on UPDATE
      // already keeps the underlying data safe either way -- this was a
      // presentation-layer gap, not a data one -- but the whole point of
      // this component is to actually show the user the choice.
      const hidden = await getFleetHiddenCount()
      if (hidden <= 0) { setLocked([]); return }
      const [owned, visibleCap] = await Promise.all([getOwnedAircraftOldestFirst(), getFleetVisibleCap()])
      setLocked(owned)
      setCap(visibleCap)
    } catch {
      // Never block the whole app on a failed lookup -- worst case the gate
      // appears on the next launch instead.
      setLocked([])
    }
  }, [userId])

  // Re-checked on navigation as well as on tier change: the entitlement can
  // flip mid-session (a restore, a webhook landing, an expiry), and this is
  // the cheapest way to notice without polling.
  useEffect(() => { check() }, [check, pathname])

  // Auth and paywall routes are deliberately exempt -- blocking someone
  // from reaching the very screen that would restore their Premium (or from
  // signing into a different account) would be a trap with no exit.
  const exempt = pathname?.startsWith('/auth') || pathname?.startsWith('/paywall')
  if (locked.length === 0 || exempt) return null

  const runKeep = async (keep: typeof locked[number]) => {
    setBusy(true)
    try {
      await keepOnlyAircraft([keep.aircraftId])
      setLocked([])
      setPending(null)
    } catch (e: any) {
      setError(e?.message ?? 'Could not update. Please try again.')
    }
    setBusy(false)
  }

  // The cap-0 (Plus/Free) case: nothing can be kept. keepOnlyAircraft([])
  // deletes every one of the caller's own aircraft -- same RPC as runKeep
  // above, just with an empty keep-list instead of one id.
  const runDeleteAll = async () => {
    setBusy(true)
    try {
      await keepOnlyAircraft([])
      setLocked([])
      setConfirmingDeleteAll(false)
    } catch (e: any) {
      setError(e?.message ?? 'Could not update. Please try again.')
    }
    setBusy(false)
  }

  const label = (a: typeof locked[number]) => a.nickname || `${a.make} ${a.model}`

  // Confirm step 2, rendered INSIDE this modal rather than via Alert.alert.
  // Alert.alert is a silent no-op on React Native Web, which is exactly how
  // "the 'keep this' buttons don't do anything" happened -- the handler ran,
  // the alert never appeared, and nothing surfaced the failure. An in-app
  // confirm also just belongs here: this is a permanent, unrecoverable
  // delete of someone's maintenance history, and it deserves a screen that
  // names every aircraft going away rather than a two-line OS dialog.
  if (pending || confirmingDeleteAll) {
    // confirmingDeleteAll (cap 0: Plus/Free): every locked aircraft is
    // going, none is being "kept" -- same confirmation screen, no single
    // aircraft to exclude from the going-list.
    const going = pending ? locked.filter((a) => a.aircraftId !== pending.aircraftId) : locked
    const closeThis = () => { setPending(null); setConfirmingDeleteAll(false) }
    return (
      <Modal visible transparent animationType="fade" onRequestClose={closeThis}>
        {/* Corpus-wide keyboard-avoidance sweep, RC real-device report. This
            card's height is unbounded (a body message plus a per-aircraft
            list that grows with `going.length`, plus the typed-DELETE input
            and buttons below it) -- on a smaller device, or with several
            aircraft in the delete list, the input/buttons can end up under
            the keyboard once it's up, with nothing here to push the card
            back into view. Same fix as ConfirmDialog.tsx's own requireTyped
            case. */}
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.scrim}>
          <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.red }]}>
            <Icon name="exclamationmark.triangle" size={fs(26)} color={tokens.red} />
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>
              {pending ? `Keep ${label(pending)} only?` : `Delete all ${going.length} aircraft?`}
            </Text>
            <Text style={[styles.body, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
              {pending
                ? `${going.length === 1 ? 'This aircraft' : `These ${going.length} aircraft`} will be permanently deleted, with their equipment, reminders, and AD history. This cannot be undone.`
                : "Your plan doesn't include Aircraft Manager, so none of these can stay. They'll be permanently deleted, with their equipment, reminders, and AD history. This cannot be undone."}
            </Text>
            <View style={styles.goingList}>
              {going.map((a) => (
                <View key={a.aircraftId} style={[styles.goingRow, { borderColor: tokens.bdr }]}>
                  <Icon name="trash" size={fs(12)} color={tokens.red} />
                  <Pressable
                    style={{ flex: 1 }}
                    onLongPress={(e) => showPreview(label(a), e)}
                    onPressOut={hidePreview}
                    delayLongPress={350}
                  >
                    <Text style={[styles.goingText, { color: tokens.t2, fontSize: fs(13) }]} numberOfLines={1}>
                      {label(a)}
                    </Text>
                  </Pressable>
                </View>
              ))}
            </View>
            {error ? (
              <Text style={[styles.errorText, { color: tokens.red, fontSize: fs(12.5) }]}>{error}</Text>
            ) : null}
            {busy ? (
              <ActivityIndicator color={tokens.t3} style={{ marginVertical: 12 }} />
            ) : (
              <>
                {/* Typed confirmation, added after this exact button
                    permanently deleted three aircraft from a single stray
                    tap. This gate is a BLOCKING modal that can appear over
                    any screen at any moment, so a tap already travelling
                    toward something else lands here -- "modal stole my tap,"
                    which any real user can hit too. A tap can no longer do
                    it; only typing can. */}
                <View style={styles.typedWrap}>
                  <Text style={[styles.typedHint, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    Type DELETE to confirm
                  </Text>
                  <TextInput
                    value={typed}
                    onChangeText={setTyped}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    placeholder="DELETE"
                    placeholderTextColor={tokens.t4}
                    style={[styles.typedInput, { color: tokens.t1, borderColor: armed ? tokens.red : tokens.bdr, fontSize: ifs(14.5) }]}
                  />
                </View>
                <Pressable
                  style={[styles.primaryBtn, { backgroundColor: armed ? tokens.red : tokens.bdim }]}
                  onPress={() => { if (armed) { if (pending) runKeep(pending); else runDeleteAll() } }}
                  disabled={!armed}
                  accessibilityState={{ disabled: !armed }}
                >
                  <Text style={[styles.destructiveBtnText, { fontSize: fs(14.5), opacity: armed ? 1 : 0.55 }]}>
                    {pending ? `Delete ${going.length} and keep ${label(pending)}` : `Delete all ${going.length} aircraft`}
                  </Text>
                </Pressable>
                <Pressable onPress={() => { closeThis(); setError(null); setTyped('') }} hitSlop={8}>
                  <Text style={[styles.cancelText, { color: tokens.t3, fontSize: fs(13.5) }]}>Cancel</Text>
                </Pressable>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
        <LongPressPreviewCard
          preview={preview}
          previewHeight={previewHeight}
          onLayoutHeight={setPreviewHeight}
          onDismiss={hidePreview}
        />
      </Modal>
    )
  }

  // cap === 0 (Plus/Free): no aircraft can be kept at all -- a completely
  // different message and flow from cap === 1 (Pro: pick-one) below. Only
  // render this branch once cap has actually loaded (null = still
  // fetching) so the pick-one UI doesn't flash first and then swap.
  if (cap === 0) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
        <View style={styles.scrim}>
          <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.gold }]}>
            <Icon name="airplane" size={fs(26)} color={tokens.gold} />
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>
              Your plan doesn't include Aircraft Manager
            </Text>
            <Text style={[styles.body, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
              Saved aircraft are stored on our servers, and come with Pro or Premium. Your current plan can't keep any of these {locked.length} — upgrade to keep them, or delete them to continue.
            </Text>
            <Pressable
              style={[styles.primaryBtn, { backgroundColor: tokens.gold }]}
              onPress={() => router.push('/paywall?tier=premium' as any)}
            >
              <Text style={[styles.primaryBtnText, { fontSize: fs(14.5) }]}>Upgrade to Premium (keep all)</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryBtn, { backgroundColor: tokens.bg2, borderWidth: 1, borderColor: tokens.gold, marginTop: 8 }]}
              onPress={() => router.push('/paywall?tier=pro' as any)}
            >
              <Text style={[styles.primaryBtnText, { color: tokens.gold, fontSize: fs(14.5) }]}>Upgrade to Pro (keep 1)</Text>
            </Pressable>

            <ScrollView style={styles.list} contentContainerStyle={{ gap: 8 }}>
              {locked.map((a) => (
                <View key={a.aircraftId} style={[styles.row, { borderColor: tokens.bdr }]}>
                  <Icon name="airplane" size={fs(13)} color={tokens.t3} />
                  <Pressable
                    style={{ flex: 1 }}
                    onLongPress={(e) => showPreview(label(a), e)}
                    onPressOut={hidePreview}
                    delayLongPress={350}
                  >
                    <Text style={[styles.rowText, { color: tokens.t1, fontSize: fs(13.5) }]} numberOfLines={1}>
                      {label(a)}
                    </Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>

            <Pressable
              style={[styles.primaryBtn, { backgroundColor: tokens.red, marginTop: 8 }]}
              onPress={() => { setTyped(''); setConfirmingDeleteAll(true) }}
            >
              <Text style={[styles.primaryBtnText, { fontSize: fs(14.5) }]}>Delete All {locked.length} Aircraft</Text>
            </Pressable>

            <Text style={[styles.footnote, { color: tokens.t4, fontSize: fs(11.5), lineHeight: fs(11.5) * 1.39 }]}>
              Nothing is deleted until you choose. Your aircraft stay locked, not lost — upgrading restores all of them.
            </Text>
          </View>
        </View>
        <LongPressPreviewCard
          preview={preview}
          previewHeight={previewHeight}
          onLayoutHeight={setPreviewHeight}
          onDismiss={hidePreview}
        />
      </Modal>
    )
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={styles.scrim}>
        <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.gold }]}>
          <Icon name="airplane" size={fs(26)} color={tokens.gold} />
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>
            Choose the aircraft you keep
          </Text>
          {/* RC: "the CTA says 'upgrade' but if a user has 4 a/c they're
              already Prem. so this box should say 'Stay with Premium'." */}
          <Text style={[styles.body, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            Saved aircraft are stored on our servers, so they come with Premium. Your plan no longer includes {locked.length} — pick the one that comes with you to Pro, or stay on Premium and keep them all.
          </Text>
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: tokens.gold }]}
            // RC gating audit, 2026-08-22: without intent=stay, this landed
            // on paywall.tsx's downgradeMode default of 'pro' -- so tapping
            // "Stay with Premium" opened a screen whose primary button said
            // "Downgrade to Pro." intent=stay tells paywall.tsx to actually
            // honor tier=premium here instead of overriding it.
            onPress={() => router.push('/paywall?tier=premium&intent=stay' as any)}
          >
            <Text style={[styles.primaryBtnText, { fontSize: fs(14.5) }]}>Stay with Premium</Text>
          </Pressable>

          <ScrollView style={styles.list} contentContainerStyle={{ gap: 8 }}>
            {locked.map((a) => (
              <Pressable
                key={a.aircraftId}
                style={[styles.row, { borderColor: tokens.bdr }]}
                onPress={() => {
                  if (consumeLongPress()) return
                  setTyped(''); setPending(a)
                }}
                onLongPress={(e) => showPreview(label(a), e)}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                <Icon name="airplane" size={fs(13)} color={tokens.t3} />
                <Text style={[styles.rowText, { color: tokens.t1, fontSize: fs(13.5) }]} numberOfLines={1}>
                  {label(a)}
                </Text>
                <Text style={[styles.rowAction, { color: tokens.blu, fontSize: fs(12.5) }]}>Keep this</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={[styles.footnote, { color: tokens.t4, fontSize: fs(11.5), lineHeight: fs(11.5) * 1.39 }]}>
            Nothing is deleted until you choose. Your aircraft stay locked, not lost — resubscribing restores all of them.
          </Text>
        </View>
      </View>
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.72)' },
  goingList: { alignSelf: 'stretch', gap: 6, marginTop: 2 },
  goingRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 10, borderWidth: 1, paddingVertical: 9, paddingHorizontal: 11,
  },
  goingText: { flex: 1, fontWeight: '600' },
  destructiveBtnText: { color: '#fff', fontWeight: '700' },
  cancelText: { fontWeight: '600', marginTop: 10 },
  typedWrap: { alignSelf: 'stretch', gap: 6, marginTop: 4 },
  typedHint: { textAlign: 'center' },
  typedInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, textAlign: 'center', fontWeight: '700' },
  errorText: { textAlign: 'center', marginTop: 4 },
  card: {
    width: '100%', maxWidth: 380, borderRadius: 18, borderWidth: 1,
    padding: 22, alignItems: 'center', gap: 10,
  },
  title: { fontWeight: '700', textAlign: 'center' },
  // lineHeight NOT set here -- always overridden inline with fs(13.5) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  body: { textAlign: 'center' },
  primaryBtn: { borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 4 },
  primaryBtnText: { color: '#000', fontWeight: '700' },
  list: { alignSelf: 'stretch', maxHeight: 240, marginTop: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    borderRadius: 10, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 12,
  },
  rowText: { flex: 1, fontWeight: '600' },
  rowAction: { fontWeight: '700' },
  // lineHeight NOT set here -- always overridden inline with fs(11.5) * 1.39
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  footnote: { textAlign: 'center', marginTop: 2 },
})
