import { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getRefPacket, getRefPackets, splitPacketTitle, refPackKnowledgeLevel, RefPacketArea, RefPacket } from '@/lib/refPackets'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

export default function RefPacketDetailScreen() {
  const { code: routeCode } = useLocalSearchParams<{ code: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess } = useAuth()
  // Separate from the route param: tapping a sibling section below updates
  // this in place (no navigation) instead of pushing a new /ref-packets/X
  // screen, so switching sections doesn't stack the back button.
  const [activeCode, setActiveCode] = useState(routeCode)
  const [title, setTitle] = useState('')
  const [areas, setAreas] = useState<RefPacketArea[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [siblings, setSiblings] = useState<RefPacket[]>([])
  // ACS task titles run long and get cut off the same way FAR Part titles do
  // -- same hook/card pair as far/index.tsx's own long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  useEffect(() => { setActiveCode(routeCode) }, [routeCode])

  useEffect(() => {
    if (!activeCode || !hasPlusAccess) { setLoading(false); return }
    setLoading(true)
    getRefPacket(activeCode).then((r) => {
      if (r) { setTitle(r.title); setAreas(r.areas) }
      setLoading(false)
    })
    setExpanded(null)
  }, [activeCode, hasPlusAccess])

  // Siblings: other acs_documents rows from the same source PDF (see
  // splitPacketTitle) -- fetched once against the full catalog rather than
  // a dedicated query, since RefPacks' whole list is small and already
  // cached client-side elsewhere (Community's own grid).
  useEffect(() => {
    if (!hasPlusAccess || !title) return
    const { mainTitle } = splitPacketTitle(title)
    getRefPackets().then((all) => {
      const group = all
        .filter((p) => splitPacketTitle(p.title).mainTitle === mainTitle)
        .sort((a, b) => a.code.localeCompare(b.code))
      setSiblings(group.length > 1 ? group : [])
    })
  }, [hasPlusAccess, title])

  // Maps this pack's title to a Study Mode knowledge level (e.g. "Private
  // Pilot..." -> 'private') so a "Study This Rating" button can jump
  // straight into a correctly-scoped flashcard deck. null for certs that
  // don't cleanly map onto the 6-level taxonomy (see refPackKnowledgeLevel).
  const studyLevel = title ? refPackKnowledgeLevel(splitPacketTitle(title).mainTitle) : null

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

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={title || 'RefPack'} onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
            {/* OverlayHeader's title is shared app-wide and hardcoded to
                1 line, so multi-section packs (same source PDF split into
                several packs, e.g. "...Sport Pilot Flight Instructor —
                Section 2") get clipped there with no way to tell them
                apart -- this shows the real, full, un-truncated title. */}
            <Text style={[styles.fullTitle, { color: tokens.t1, fontSize: fs(17) }]}>{splitPacketTitle(title).mainTitle}</Text>

            {studyLevel && (
              <Pressable
                style={[styles.studyBtn, { backgroundColor: tokens.blu }]}
                onPress={() => router.push(`/study?level=${studyLevel}` as any)}
              >
                <Icon name="rectangle.stack.fill" size={fs(15)} color="#fff" />
                <Text style={[styles.studyBtnText, { fontSize: fs(13.5) }]}>Study This Rating</Text>
              </Pressable>
            )}

            {siblings.length > 1 && (
              <>
                <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>SECTION</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sectionRow} contentContainerStyle={styles.sectionRowContent}>
                  {siblings.map((s) => {
                    const active = s.code === activeCode
                    const { suffix } = splitPacketTitle(s.title)
                    return (
                      <Pressable
                        key={s.code}
                        style={[
                          styles.sectionChip,
                          { backgroundColor: active ? tokens.gold : tokens.bg2, borderColor: active ? tokens.gold : tokens.bdr },
                        ]}
                        onPress={() => setActiveCode(s.code)}
                      >
                        <Text style={[styles.sectionChipText, { color: active ? '#000' : tokens.t2, fontSize: fs(12.5) }]}>
                          {suffix ?? s.code}
                        </Text>
                      </Pressable>
                    )
                  })}
                </ScrollView>
              </>
            )}

            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
              {areas.length} AREA{areas.length !== 1 ? 'S' : ''} OF OPERATION
            </Text>
            {areas.map((area) => {
              const isOpen = expanded === area.areaNumber
              return (
                <View key={area.areaNumber} style={[styles.areaCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                  <Pressable
                    style={styles.areaHeader}
                    onPress={() => setExpanded((prev) => (prev === area.areaNumber ? null : area.areaNumber))}
                  >
                    <View style={[styles.areaNumBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
                      <Text style={[styles.areaNumText, { color: tokens.gold, fontSize: fs(12) }]}>{area.areaNumber}</Text>
                    </View>
                    <Text style={[styles.areaTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={isOpen ? undefined : 2}>
                      {area.title}
                    </Text>
                    <Text style={[styles.taskCount, { color: tokens.t4, fontSize: fs(11.5) }]}>{area.tasks.length}</Text>
                    <Icon name={isOpen ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.t3} />
                  </Pressable>
                  {isOpen && (
                    <View style={styles.taskList}>
                      {area.tasks.map((task) => (
                        <Pressable
                          key={task.id}
                          style={[styles.taskRow, { borderTopColor: tokens.bdr }]}
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
                    </View>
                  )}
                </View>
              )
            })}
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
  fullTitle: { fontWeight: '700', lineHeight: 22, marginBottom: 10, paddingLeft: 2 },
  studyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    borderRadius: 12, paddingVertical: 11, marginBottom: 14,
  },
  studyBtnText: { color: '#fff', fontWeight: '700' },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  sectionRow: { marginBottom: 14 },
  sectionRowContent: { gap: 8, paddingRight: 12 },
  sectionChip: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 7 },
  sectionChipText: { fontWeight: '700' },

  areaCard: { borderRadius: 14, borderWidth: 1, marginBottom: 8, overflow: 'hidden' },
  areaHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13 },
  areaNumBadge: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4, minWidth: 28, alignItems: 'center' },
  areaNumText: { fontWeight: '700' },
  areaTitle: { flex: 1, fontWeight: '600' },
  taskCount: { fontWeight: '600' },

  taskList: { paddingBottom: 4 },
  taskRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 14, borderTopWidth: StyleSheet.hairlineWidth,
  },
  taskLetter: { fontWeight: '700', width: 18 },
  taskTitle: { flex: 1, fontWeight: '500' },
})
