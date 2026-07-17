import { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, Pressable, ActivityIndicator, Alert, StyleSheet } from 'react-native'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'
import { getSharedFolderACItems, leaveSharedFolder } from '@/lib/sharedFolders'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { isOcrScanned } from '@/lib/ocrScannedACs'

interface ACRow {
  id: string
  document_number: string
  title: string
  cancels: string[]
  changed_block_indices: number[] | null
  date_issued: string | null
}

// Read-only view of a folder someone else shared with you — no rename,
// delete, add, or remove controls, only opening each AC (which is still
// gated the same as anywhere else in the app: full text needs your OWN
// Pro/Premium subscription, being invited here doesn't unlock it).
export default function SharedFolderDetail() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { badgeDays } = useBadgeLifespan()
  const [folderName, setFolderName] = useState('')
  const [ownerName, setOwnerName] = useState<string | null>(null)
  const [acs, setAcs] = useState<ACRow[]>([])
  const [loading, setLoading] = useState(true)
  const [removed, setRemoved] = useState(false)

  const load = useCallback(async () => {
    if (typeof id !== 'string') return
    setLoading(true)
    const [{ data: folder }, items] = await Promise.all([
      supabase.from('synced_folders').select('name').eq('id', id).eq('deleted', false).maybeSingle(),
      getSharedFolderACItems(id),
    ])
    if (!folder) {
      setRemoved(true)
      setLoading(false)
      return
    }
    setFolderName(folder.name)

    // Best-effort -- owner name is a nice-to-have, not load-bearing.
    try {
      const { data } = await supabase.rpc('get_shared_folder_owners', { p_folder_ids: [id] })
      setOwnerName(data?.[0]?.out_owner_display_name ?? null)
    } catch {
      setOwnerName(null)
    }

    const acIds = items.map((i) => i.item_id)
    if (acIds.length) {
      const { data: acRows } = await supabase
        .from('advisory_circulars')
        .select('id, document_number, title, cancels, changed_block_indices, date_issued')
        .in('id', acIds)
      setAcs(acRows ?? [])
    } else {
      setAcs([])
    }
    setLoading(false)
  }, [id])

  useFocusEffect(useCallback(() => { load() }, [load]))

  const handleLeave = () => {
    if (typeof id !== 'string') return
    Alert.alert('Leave Shared Folder', `You'll lose access to "${folderName}". You can rejoin later with a new invite link.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          await leaveSharedFolder(id)
          router.back()
        },
      },
    ])
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        title={folderName}
        onBack={() => router.back()}
        right={
          <Pressable onPress={handleLeave} hitSlop={10}>
            <Icon name="rectangle.portrait.and.arrow.right" size={fs(20)} color={tokens.t3} />
          </Pressable>
        }
      />
      <View style={[styles.badgeRow, { borderBottomColor: tokens.bdr }]}>
        <Icon name="person.2.fill" size={13} color={tokens.t3} />
        <Text style={[styles.badgeText, { color: tokens.t3, fontSize: fs(12) }]}>
          {ownerName ? `Shared by ${ownerName} — view only` : 'Shared with you — view only'}
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : removed ? (
        <View style={styles.center}>
          <Icon name="folder" size={36} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(15) }]}>
            This folder is no longer shared
          </Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13) }]}>
            The owner deleted it or stopped sharing.
          </Text>
        </View>
      ) : acs.length === 0 ? (
        <View style={styles.center}>
          <Icon name="folder" size={36} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(15) }]}>Nothing here yet</Text>
        </View>
      ) : (
        <FlatList
          data={acs}
          keyExtractor={(a) => a.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => router.push(`/ac/${item.id}`)}
            >
              <View style={{ flex: 1 }}>
                <View style={styles.rowNumBadgeWrap}>
                  <Text style={[styles.rowDoc, { color: tokens.blu, fontSize: fs(13) }]}>
                    {item.document_number}{isOcrScanned(item.document_number) ? ' *' : ''}
                  </Text>
                  {isWithinBadgeLifespan(item.date_issued, badgeDays) && (() => {
                    const badge = getBadgeStyle(getBadgeKind(item), tokens)
                    return (
                      <View style={[styles.rowNumBadge, { backgroundColor: badge.background, borderColor: badge.border }]}>
                        <Text style={[styles.rowNumBadgeText, { color: badge.color, fontSize: fs(8) }]}>{badge.label}</Text>
                      </View>
                    )
                  })()}
                </View>
                <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={2}>
                  {item.title}
                </Text>
              </View>
              <Icon name="chevron.right" size={14} color={tokens.t4} />
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  badgeText: { fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyTitle: { fontWeight: '600', textAlign: 'center' },
  emptySub: { textAlign: 'center', marginTop: 2 },
  list: { padding: 16, gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowDoc: { fontWeight: '700', marginBottom: 2 },
  rowNumBadgeWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  rowNumBadge: { borderRadius: 5, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 1.5 },
  rowNumBadgeText: { fontWeight: '700', letterSpacing: 0.3 },
  rowTitle: { fontWeight: '500' },
})
