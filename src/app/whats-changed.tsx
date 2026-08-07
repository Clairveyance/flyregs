import { useEffect, useState } from 'react'
import { View, Text, SectionList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import {
  getRevisions,
  routeForRevision,
  labelForDocType,
  splitParagraphs,
  ContentRevision,
} from '@/lib/whatsChanged'
import { stripAdSubjectPrefix } from '@/lib/titleFormat'

interface RevisionSection {
  title: string
  data: ContentRevision[]
}

function groupByDate(revisions: ContentRevision[]): RevisionSection[] {
  const sections: RevisionSection[] = []
  for (const r of revisions) {
    const label = new Date(r.revisedAt).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    })
    let s = sections.find((s) => s.title === label)
    if (!s) { s = { title: label, data: [] }; sections.push(s) }
    s.data.push(r)
  }
  return sections
}

export default function WhatsChangedScreen() {
  const { tokens, redShift } = useTheme()
  const fs = useFS()
  const { hasPlusAccess } = useAuth()
  const [revisions, setRevisions] = useState<ContentRevision[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!hasPlusAccess) { setLoading(false); return }
    getRevisions().then((r) => { setRevisions(r); setLoading(false) })
  }, [hasPlusAccess])

  if (!hasPlusAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="What's Changed" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>What's Changed is a Plus feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            A real, browsable history of exactly what changed in every revision — not just a "this was updated" badge.
          </Text>
          <Pressable style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall?tier=plus')}>
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  const sections = groupByDate(revisions)

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="What's Changed" onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : revisions.length === 0 ? (
        <View style={styles.center}>
          <Icon name="doc.badge.clock" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No revisions logged yet</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Real content changes will show up here as they're published.
          </Text>
        </View>
      ) : (
        <TabletContainer>
          <SectionList
            sections={sections}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            renderSectionHeader={({ section }) => (
              <Text style={[styles.dateHeader, { color: tokens.t3, fontSize: fs(11) }]}>{section.title.toUpperCase()}</Text>
            )}
            renderItem={({ item }) => (
              <RevisionRow
                item={item}
                tokens={tokens}
                redShift={redShift}
                fs={fs}
                expanded={expanded === item.id}
                onToggle={() => setExpanded((prev) => (prev === item.id ? null : item.id))}
              />
            )}
          />
        </TabletContainer>
      )}
    </View>
  )
}

function RevisionRow({
  item,
  tokens,
  redShift,
  fs,
  expanded,
  onToggle,
}: {
  item: ContentRevision
  tokens: ReturnType<typeof useTheme>['tokens']
  redShift: boolean
  fs: (n: number) => number
  expanded: boolean
  onToggle: () => void
}) {
  const added = splitParagraphs(item.addedText)
  const removed = splitParagraphs(item.removedText)
  const title = item.docType === 'ad' ? stripAdSubjectPrefix(item.title ?? item.docKey) : (item.title ?? item.docKey)

  return (
    <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
      <Pressable style={styles.cardHeader} onPress={onToggle}>
        <View style={[styles.typeChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
          <Text style={[styles.typeChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>{labelForDocType(item.docType)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={expanded ? undefined : 3}>
            {title}
          </Text>
          <Text style={[styles.diffCounts, { color: tokens.t4, fontSize: fs(11.5) }]}>
            {added.length > 0 && `+${added.length}`}{added.length > 0 && removed.length > 0 && ' '}
            {removed.length > 0 && `−${removed.length}`}
            {added.length === 0 && removed.length === 0 && 'Revised'}
          </Text>
        </View>
        <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.t3} />
      </Pressable>

      {expanded && (
        <View style={styles.diffBody}>
          {added.map((p, i) => (
            <View key={`a${i}`} style={[styles.diffLine, { backgroundColor: tokens.gdim, borderColor: tokens.gbdr }]}>
              <Text style={[styles.diffMark, { color: tokens.grn, fontSize: fs(13) }]}>+</Text>
              <Text style={[styles.diffText, { color: tokens.t1, fontSize: fs(13) }]}>{p}</Text>
            </View>
          ))}
          {removed.map((p, i) => (
            <View key={`r${i}`} style={[styles.diffLine, redShift ? { backgroundColor: 'rgba(255,45,18,0.08)', borderColor: 'rgba(255,45,18,0.3)' } : { backgroundColor: 'rgba(220,60,60,0.08)', borderColor: 'rgba(220,60,60,0.3)' }]}>
              <Text style={[styles.diffMark, { color: tokens.red, fontSize: fs(13) }]}>−</Text>
              <Text style={[styles.diffText, styles.diffTextRemoved, { color: tokens.t3, fontSize: fs(13) }]}>{p}</Text>
            </View>
          ))}
          <Pressable
            style={[styles.openBtn, { borderColor: tokens.bdr }]}
            onPress={() => router.push(routeForRevision(item) as any)}
          >
            <Text style={[styles.openBtnText, { color: tokens.blu, fontSize: fs(13) }]}>Open full document</Text>
            <Icon name="chevron.right" size={fs(12)} color={tokens.blu} />
          </Pressable>
        </View>
      )}
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
  dateHeader: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, marginTop: 10, paddingLeft: 2 },

  card: { borderRadius: 14, borderWidth: 1, marginBottom: 8, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13 },
  typeChip: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3 },
  typeChipText: { fontWeight: '700', letterSpacing: 0.3 },
  cardTitle: { fontWeight: '600', lineHeight: 19 },
  diffCounts: { marginTop: 2, fontWeight: '600' },

  diffBody: { paddingHorizontal: 13, paddingBottom: 13, gap: 6 },
  diffLine: { flexDirection: 'row', gap: 8, borderRadius: 8, borderWidth: 1, padding: 9 },
  diffMark: { fontWeight: '700', width: 12 },
  diffText: { flex: 1, lineHeight: 19 },
  diffTextRemoved: { textDecorationLine: 'line-through' },

  openBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 10, borderWidth: 1, paddingVertical: 10, marginTop: 4,
  },
  openBtnText: { fontWeight: '600' },
})
