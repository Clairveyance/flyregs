import { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getRefPacket, RefPacketArea } from '@/lib/refPackets'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// Multiengine (AMEL/AMES) isn't its own ACS/PTS document -- the FAA covers
// it as "Area of Operation X: Multiengine Operations" appended to BOTH the
// Private Pilot ACS (FAA-S-ACS-6C) and the Commercial Pilot ACS
// (FAA-S-ACS-7B), each with its own real tolerances for the same 4 tasks
// (confirmed live: VMC Demonstration recovery airspeed is +10/-5kt for
// Private vs +/-5kt for Commercial -- a merged pack would misstate whichever
// certificate it didn't come from). So this screen is a toggle over the two
// REAL existing doc_codes, not a new synthetic RefPack/doc_code -- per RC's
// own framing of the two options ("a toggle... or just highlight the ASC
// standard diffs"), the toggle re-points the same getRefPacket() call this
// module already exports, no schema change or data copy.
const CERTS = [
  { code: 'FAA-S-ACS-6C', label: 'Private' },
  { code: 'FAA-S-ACS-7B', label: 'Commercial' },
] as const

export default function MultiEngineRefPackScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess, loading: authLoading } = useAuth()
  // RC: two separate RefPack cards now (Private / Commercial), each
  // deep-linking here with `?cert=` so the right one opens directly --
  // falls back to Private if the param's missing or doesn't match either
  // real doc_code (e.g. someone navigates here without the param).
  const { cert: certParam } = useLocalSearchParams<{ cert?: string }>()
  const initialCert = CERTS.find((c) => c.code === certParam)?.code ?? CERTS[0].code
  const [cert, setCert] = useState<(typeof CERTS)[number]['code']>(initialCert)
  const [areas, setAreas] = useState<Record<string, RefPacketArea | null>>({})
  const [loading, setLoading] = useState(true)
  // ACS task titles run long and get cut off the same way FAR Part titles do
  // -- same hook/card pair as far/index.tsx's own long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  useEffect(() => {
    if (!hasPlusAccess) { setLoading(false); return }
    // RC's account gates (isPro/isPremium/isUnlocked) resolve asynchronously
    // after this screen's first render -- hasPlusAccess starts false, so the
    // early-return above already fired once and left `loading` false before
    // this effect ever re-runs with the real value. Without resetting it back
    // to true here, the moment hasPlusAccess flips true this component skips
    // straight past the spinner and renders "AREA X · 0 TASKS" (the still-
    // empty initial `areas` state) for the full round-trip of the real
    // fetch below -- confirmed live. ref-packets/[code].tsx's own identical
    // effect already gets this right (its own `setLoading(true)` right here);
    // this screen was missing the same line.
    setLoading(true)
    Promise.all(CERTS.map((c) => getRefPacket(c.code))).then(([priv, comm]) => {
      setAreas({
        [CERTS[0].code]: priv?.areas.find((a) => a.areaNumber === 'X') ?? null,
        [CERTS[1].code]: comm?.areas.find((a) => a.areaNumber === 'X') ?? null,
      })
      setLoading(false)
    })
  }, [hasPlusAccess])

  // Same guard as ref-packets/[code].tsx -- the effect above already handles
  // the "access resolved late" half of this race; this handles the other
  // half, where the LOCK (not the spinner) is what a real Plus subscriber
  // sees while auth's `loading` is still true.
  if (!hasPlusAccess && authLoading) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="RefPack" onBack={() => router.back()} />
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      </View>
    )
  }

  if (!hasPlusAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="RefPack" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>RefPacks are a Plus feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Certificate and rating study guides, built from the FAA's own ACS/PTS standards — every reference
            already linked to the real FAR, AC, and AIM text.
          </Text>
          <Pressable style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall?tier=plus')}>
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  const active = areas[cert]

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Multiengine Operations" onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
            <Text style={[styles.fullTitle, { color: tokens.t1, fontSize: fs(17) }]}>Multiengine Operations (AMEL/AMES)</Text>

            <View style={[styles.toggleRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              {CERTS.map((c) => {
                const isActive = cert === c.code
                return (
                  <Pressable
                    key={c.code}
                    style={[styles.toggleBtn, isActive && { backgroundColor: tokens.gold }]}
                    onPress={() => setCert(c.code)}
                  >
                    <Text style={[styles.toggleText, { color: isActive ? '#000' : tokens.t2, fontSize: fs(13.5) }]}>
                      {c.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>

            <View style={[styles.noteCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              <Icon name="exclamationmark.triangle.fill" size={fs(13)} color={tokens.amb} />
              <Text style={[styles.noteText, { color: tokens.t2, fontSize: fs(12.5) }]}>
                Private and Commercial standards differ for the same maneuvers — e.g. VMC Demonstration recovery
                airspeed is +10/-5 kt for Private, ±5 kt for Commercial. Switch above to see the standard that
                actually applies to your certificate.
              </Text>
            </View>

            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
              AREA X · {active?.tasks.length ?? 0} TASKS
            </Text>
            {active?.tasks.map((task) => (
              <Pressable
                key={task.id}
                style={[styles.taskRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => {
                  if (consumeLongPress()) return
                  router.push(`/ref-packets/task/${task.id}` as any)
                }}
                onLongPress={(e) => showPreview(task.title, e)}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                <Text style={[styles.taskLetter, { color: tokens.blu, fontSize: fs(13) }]}>{task.taskLetter}</Text>
                <Text style={[styles.taskTitle, { color: tokens.t1, fontSize: fs(13.5) }]} numberOfLines={2}>
                  {task.title}
                </Text>
                <Icon name="chevron.right" size={fs(12)} color={tokens.t4} />
              </Pressable>
            ))}
          </ScrollView>
        </TabletContainer>
      )}
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 300 },
  upgradeBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, marginTop: 10 },
  upgradeBtnText: { color: '#fff', fontWeight: '700' },

  list: { padding: 12, paddingBottom: 32 },
  fullTitle: { fontWeight: '700', lineHeight: 22, marginBottom: 12, paddingLeft: 2 },

  toggleRow: { flexDirection: 'row', borderRadius: 12, borderWidth: 1, padding: 3, marginBottom: 12 },
  toggleBtn: { flex: 1, borderRadius: 9, paddingVertical: 9, alignItems: 'center' },
  toggleText: { fontWeight: '700' },

  noteCard: { flexDirection: 'row', gap: 9, borderRadius: 12, borderWidth: 1, padding: 12, marginBottom: 16 },
  noteText: { flex: 1, lineHeight: 17 },

  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  taskRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, padding: 13, marginBottom: 8,
  },
  taskLetter: { fontWeight: '700', width: 18 },
  taskTitle: { flex: 1, fontWeight: '500' },
})
