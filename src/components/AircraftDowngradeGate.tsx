import { useEffect, useState, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert, Modal } from 'react-native'
import { router, usePathname } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { Icon } from '@/components/Icon'
import { getFleetHiddenCount, getOwnedAircraftOldestFirst, keepOnlyAircraft } from '@/lib/aircraftSharing'

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
  const { session, isPremium } = useAuth()
  const pathname = usePathname()
  const [locked, setLocked] = useState<{ aircraftId: string; make: string; model: string; nickname: string | null }[]>([])
  const [busy, setBusy] = useState(false)

  const check = useCallback(async () => {
    if (!session || isPremium) { setLocked([]); return }
    try {
      // Server count first: it's the tier-of-record answer, so a client
      // whose RevenueCat read is momentarily stale can't skip the gate.
      const hidden = await getFleetHiddenCount()
      if (hidden <= 0) { setLocked([]); return }
      setLocked(await getOwnedAircraftOldestFirst())
    } catch {
      // Never block the whole app on a failed lookup -- worst case the gate
      // appears on the next launch instead.
      setLocked([])
    }
  }, [session, isPremium])

  // Re-checked on navigation as well as on tier change: the entitlement can
  // flip mid-session (a restore, a webhook landing, an expiry), and this is
  // the cheapest way to notice without polling.
  useEffect(() => { check() }, [check, pathname])

  // Auth and paywall routes are deliberately exempt -- blocking someone
  // from reaching the very screen that would restore their Premium (or from
  // signing into a different account) would be a trap with no exit.
  const exempt = pathname?.startsWith('/auth') || pathname?.startsWith('/paywall')
  if (locked.length === 0 || exempt) return null

  const confirmKeep = (keep: typeof locked[number]) => {
    const keepLabel = keep.nickname || `${keep.make} ${keep.model}`
    const going = locked
      .filter((a) => a.aircraftId !== keep.aircraftId)
      .map((a) => a.nickname || `${a.make} ${a.model}`)
    Alert.alert(
      `Keep ${keepLabel}?`,
      `${going.join(', ')} will be permanently deleted, along with their equipment, reminders, and AD history. This cannot be undone.\n\nStaying on Premium keeps all of them.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Keep ${keepLabel} only`,
          style: 'destructive',
          onPress: async () => {
            setBusy(true)
            try {
              await keepOnlyAircraft([keep.aircraftId])
              setLocked([])
            } catch (e: any) {
              Alert.alert('Could not update', e?.message ?? 'Please try again.')
            }
            setBusy(false)
          },
        },
      ]
    )
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={[styles.scrim, { backgroundColor: 'rgba(0,0,0,0.72)' }]}>
        <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.gold }]}>
          <Icon name="airplane" size={fs(26)} color={tokens.gold} />
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>
            Choose the aircraft you keep
          </Text>
          {/* RC: "the CTA says 'upgrade' but if a user has 4 a/c they're
              already Prem. so this box should say 'Stay with Premium'." */}
          <Text style={[styles.body, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Saved aircraft are stored on our servers, so they come with Premium. Your plan no longer includes {locked.length} — pick the one that comes with you to Pro, or stay on Premium and keep them all.
          </Text>
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: tokens.gold }]}
            onPress={() => router.push('/paywall?tier=premium' as any)}
          >
            <Text style={[styles.primaryBtnText, { fontSize: fs(14.5) }]}>Stay with Premium</Text>
          </Pressable>

          {busy ? (
            <ActivityIndicator color={tokens.t3} style={{ marginVertical: 14 }} />
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={{ gap: 8 }}>
              {locked.map((a) => (
                <Pressable
                  key={a.aircraftId}
                  style={[styles.row, { borderColor: tokens.bdr }]}
                  onPress={() => confirmKeep(a)}
                >
                  <Icon name="airplane" size={fs(13)} color={tokens.t3} />
                  <Text style={[styles.rowText, { color: tokens.t1, fontSize: fs(13.5) }]} numberOfLines={1}>
                    {a.nickname || `${a.make} ${a.model}`}
                  </Text>
                  <Text style={[styles.rowAction, { color: tokens.blu, fontSize: fs(12.5) }]}>Keep this</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          <Text style={[styles.footnote, { color: tokens.t4, fontSize: fs(11.5) }]}>
            Nothing is deleted until you choose. Your aircraft stay locked, not lost — resubscribing restores all of them.
          </Text>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    width: '100%', maxWidth: 380, borderRadius: 18, borderWidth: 1,
    padding: 22, alignItems: 'center', gap: 10,
  },
  title: { fontWeight: '700', textAlign: 'center' },
  body: { textAlign: 'center', lineHeight: 19 },
  primaryBtn: { borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 4 },
  primaryBtnText: { color: '#000', fontWeight: '700' },
  list: { alignSelf: 'stretch', maxHeight: 240, marginTop: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    borderRadius: 10, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 12,
  },
  rowText: { flex: 1, fontWeight: '600' },
  rowAction: { fontWeight: '700' },
  footnote: { textAlign: 'center', lineHeight: 16, marginTop: 2 },
})
