import { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, Pressable, ActivityIndicator, Alert, StyleSheet } from 'react-native'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'
import { getSharedFolderACItems, leaveSharedFolder } from '@/lib/sharedFolders'

interface ACRow {
  id: string
  document_number: string
  title: string
}

// Read-only view of a folder someone else shared with you — no rename,
// delete, add, or remove controls, only opening each AC (which is still
// gated the same as anywhere else in the app: full text needs your OWN
// Pro/Premium subscription, being invited here doesn't unlock it).
export default function SharedFolderDetail() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [folderName, setFolderName] = useState('')
  const [acs, setAcs] = useState<ACRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (typeof id !== 'string') return
    setLoading(true)
    const [{ data: folder }, items] = await Promise.all([
      supabase.from('synced_folders').select('name').eq('id', id).maybeSingle(),
      getSharedFolderACItems(id),
    ])
    setFolderName(folder?.name ?? 'Shared folder')

    const acIds = items.map((i) => i.item_id)
    if (acIds.length) {
      const { data: acRows } = await supabase
        .from('advisory_circulars')
        .select('id, document_number, title')
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
          Shared with you — view only
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
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
                <Text style={[styles.rowDoc, { color: tokens.blu, fontSize: fs(13) }]}>{item.document_number}</Text>
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
  emptyTitle: { fontWeight: '600' },
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
  rowTitle: { fontWeight: '500' },
})
