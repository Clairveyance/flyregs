import React, { useState, useEffect, useRef } from 'react'
import {
  Modal,
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { Icon } from '@/components/Icon'
import {
  getFolders,
  getFoldersForItem,
  addToFolder,
  removeFromFolder,
  createFolder,
  Folder,
} from '@/lib/folders'

interface Props {
  visible: boolean
  itemType: 'ac' | 'note'
  itemId: string
  onClose: () => void
  /** Called on close with a ready-to-show confirmation message, only if at
   * least one folder was added to during this session (not on remove-only,
   * not if nothing changed). */
  onAdded?: (message: string) => void
}

export function FolderPicker({ visible, itemType, itemId, onClose, onAdded }: Props) {
  const { tokens } = useTheme()
  const fs = useFS()
  const { isPro } = useAuth()
  const [folders, setFolders] = useState<Folder[]>([])
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set())
  const [addedNames, setAddedNames] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    if (!visible) return
    setAddedNames([])
    load()
  }, [visible, itemId])

  useEffect(() => {
    if (creating) setTimeout(() => inputRef.current?.focus(), 80)
  }, [creating])

  const load = async () => {
    const [allFolders, memberFolderIds] = await Promise.all([
      getFolders(),
      getFoldersForItem(itemType, itemId),
    ])
    setFolders(allFolders)
    setMemberIds(new Set(memberFolderIds))
  }

  // Multi-select: tapping a folder toggles membership without closing, so
  // the user can add to several folders in one visit. The sheet only closes
  // via Done (or the backdrop/X), at which point a single summarized toast
  // fires for everything added this session.
  const toggle = async (folder: Folder) => {
    if (memberIds.has(folder.id)) {
      await removeFromFolder(folder.id, itemType, itemId)
      setMemberIds((prev) => { const s = new Set(prev); s.delete(folder.id); return s })
      setAddedNames((prev) => prev.filter((n) => n !== folder.name))
    } else {
      await addToFolder(folder.id, itemType, itemId)
      setMemberIds((prev) => new Set([...prev, folder.id]))
      setAddedNames((prev) => [...prev, folder.name])
    }
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    const folder = await createFolder(name)
    await addToFolder(folder.id, itemType, itemId)
    setFolders((prev) => [...prev, folder])
    setMemberIds((prev) => new Set([...prev, folder.id]))
    setAddedNames((prev) => [...prev, folder.name])
    setNewName('')
    setCreating(false)
  }

  const cancelCreate = () => { setCreating(false); setNewName('') }

  const handleClose = () => {
    if (addedNames.length === 1) onAdded?.(`Added to ${addedNames[0]}`)
    else if (addedNames.length > 1) onAdded?.('Added to multiple folders')
    setCreating(false)
    setNewName('')
    onClose()
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.avoidingView}
      >
        <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={handleClose} />
        <View style={[styles.sheet, { backgroundColor: tokens.bg2, borderTopColor: tokens.bdr2 }]}>
          {/* Grip */}
          <View style={styles.gripRow}>
            <View style={[styles.grip, { backgroundColor: tokens.t3 }]} />
          </View>

          {/* Header */}
          <View style={[styles.header, { borderBottomColor: tokens.bdr }]}>
            <Text style={[styles.headerTitle, { color: tokens.t1, fontSize: fs(15) }]}>Add to Folder(s)</Text>
            <Pressable onPress={handleClose} style={[styles.doneBtn, { backgroundColor: tokens.blu }]} hitSlop={4}>
              <Text style={[styles.doneBtnText, { fontSize: fs(13) }]}>Done</Text>
            </Pressable>
          </View>

          {/* Folder list */}
          {folders.length === 0 && !creating ? (
            <Text style={[styles.emptyText, { color: tokens.t3, fontSize: fs(13) }]}>
              No folders yet — create one below.
            </Text>
          ) : (
            <FlatList
              data={folders}
              keyExtractor={(f) => f.id}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const isMember = memberIds.has(item.id)
                return (
                  <Pressable
                    style={[styles.folderRow, { borderBottomColor: tokens.bdr }]}
                    onPress={() => toggle(item)}
                  >
                    <Icon
                      name={isMember ? 'folder.fill' : 'folder'}
                      size={19}
                      color={isMember ? tokens.blu : tokens.t3}
                    />
                    <Text style={[styles.folderName, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {isMember && (
                      <Icon name="checkmark" size={14} color={tokens.blu} />
                    )}
                  </Pressable>
                )
              }}
            />
          )}

          {/* Create row */}
          {creating ? (
            <View style={[styles.createRow, { borderTopColor: tokens.bdr, backgroundColor: tokens.bg2 }]}>
              <TextInput
                ref={inputRef}
                style={[styles.nameInput, { color: tokens.t1, borderColor: tokens.bdr2, backgroundColor: tokens.inp ?? tokens.bg, fontSize: fs(14) }]}
                placeholder="Folder name"
                placeholderTextColor={tokens.t3}
                value={newName}
                onChangeText={setNewName}
                returnKeyType="done"
                onSubmitEditing={handleCreate}
                maxLength={60}
              />
              <Pressable
                onPress={handleCreate}
                style={[styles.createBtn, { backgroundColor: tokens.blu, opacity: newName.trim() ? 1 : 0.5 }]}
              >
                <Text style={[styles.createBtnText, { fontSize: fs(13) }]}>Create</Text>
              </Pressable>
              <Pressable onPress={cancelCreate} hitSlop={8}>
                <Icon name="xmark" size={15} color={tokens.t3} />
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={[styles.newFolderRow, { borderTopColor: tokens.bdr }]}
              onPress={() => {
                if (!isPro) { handleClose(); setTimeout(() => router.push('/paywall'), 200); return }
                setCreating(true)
              }}
            >
              <Icon name="folder.badge.plus" size={19} color={tokens.blu} />
              <Text style={[styles.newFolderText, { color: tokens.blu, fontSize: fs(14.5) }]}>New Folder</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  avoidingView: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    maxHeight: '70%',
    marginBottom: 100,
  },
  gripRow: { alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
  grip: { width: 38, height: 4, borderRadius: 2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { flex: 1, fontWeight: '600', fontSize: 15 },
  doneBtn: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 7 },
  doneBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  list: { maxHeight: 300 },
  emptyText: { fontSize: 13, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 20 },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  folderName: { flex: 1, fontSize: 14.5, fontWeight: '500' },
  newFolderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderTopWidth: 1,
  },
  newFolderText: { fontSize: 14.5, fontWeight: '600' },
  createRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  nameInput: {
    flex: 1,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  createBtn: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  createBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
})
