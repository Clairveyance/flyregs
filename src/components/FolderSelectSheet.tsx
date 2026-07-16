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
  Alert,
} from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { Icon } from '@/components/Icon'
import { getFolders, createFolder, Folder, DUPLICATE_FOLDER_NAME } from '@/lib/folders'

// Multi-select folder sheet for bulk operations (adding several items at
// once). Tapping a folder toggles a checkmark WITHOUT closing or writing to
// the DB yet -- selection only commits when Done is tapped, matching
// FolderPicker's per-item toggle pattern so the two "add to folder" flows in
// the app behave consistently. Bug fixed 2026-07-09: this used to call
// onSelect(folderId) and close immediately on the very first tap, with no
// way to pick more than one folder for a bulk selection.

interface Props {
  visible: boolean
  title?: string
  onConfirm: (folderIds: string[]) => void
  onClose: () => void
  /** Hide one folder from the list -- used by the "Move to Folder" flow so an
   * item can't be "moved" into the folder it's already sitting in. */
  excludeFolderId?: string
}

export function FolderSelectSheet({ visible, title = 'Add to Folder', onConfirm, onClose, excludeFolderId }: Props) {
  const { tokens } = useTheme()
  const fs = useFS()
  const { isPro } = useAuth()
  const [folders, setFolders] = useState<Folder[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    if (!visible) return
    // Same Pro-gating gap as FolderPicker: folders are Pro end-to-end, not
    // just creation -- gate here too, not only on the "New Folder" row below.
    if (!isPro) {
      onClose()
      setTimeout(() => router.push('/paywall'), 200)
      return
    }
    getFolders().then((all) => setFolders(excludeFolderId ? all.filter((f) => f.id !== excludeFolderId) : all))
    setSelected(new Set())
    setCreating(false)
    setNewName('')
  }, [visible, isPro, excludeFolderId])

  useEffect(() => {
    if (creating) setTimeout(() => inputRef.current?.focus(), 80)
  }, [creating])

  const toggle = (folderId: string) => {
    setSelected((prev) => {
      const s = new Set(prev)
      if (s.has(folderId)) s.delete(folderId)
      else s.add(folderId)
      return s
    })
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    let folder: Folder
    try {
      folder = await createFolder(name)
    } catch (e) {
      if (e instanceof Error && e.message === DUPLICATE_FOLDER_NAME) {
        Alert.alert('Folder Already Exists', `You already have a folder named "${name}". Choose a different name.`)
        return
      }
      throw e
    }
    setFolders((prev) => [...prev, folder])
    setSelected((prev) => new Set([...prev, folder.id]))
    setNewName('')
    setCreating(false)
  }

  const handleDone = () => {
    if (selected.size > 0) onConfirm([...selected])
    else onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.avoidingView}
      >
        <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: tokens.bg2, borderTopColor: tokens.bdr2 }]}>
          <View style={styles.gripRow}>
            <View style={[styles.grip, { backgroundColor: tokens.t3 }]} />
          </View>

          <View style={[styles.header, { borderBottomColor: tokens.bdr }]}>
            <Text style={[styles.headerTitle, { color: tokens.t1, fontSize: fs(15) }]}>{title}</Text>
            <Pressable
              onPress={handleDone}
              style={[styles.doneBtn, { backgroundColor: tokens.blu, opacity: selected.size > 0 ? 1 : 0.5 }]}
              hitSlop={4}
            >
              <Text style={[styles.doneBtnText, { fontSize: fs(13) }]}>Done</Text>
            </Pressable>
          </View>

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
              keyboardDismissMode="interactive"
              renderItem={({ item }) => {
                const isSelected = selected.has(item.id)
                return (
                  <Pressable
                    style={[styles.folderRow, { borderBottomColor: tokens.bdr }]}
                    onPress={() => toggle(item.id)}
                  >
                    <Icon
                      name={isSelected ? 'folder.fill' : 'folder'}
                      size={19}
                      color={isSelected ? tokens.blu : tokens.t3}
                    />
                    <Text style={[styles.folderName, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {isSelected && (
                      <Icon name="checkmark" size={14} color={tokens.blu} />
                    )}
                  </Pressable>
                )
              }}
            />
          )}

          {creating ? (
            <View style={[styles.createRow, { borderTopColor: tokens.bdr, backgroundColor: tokens.bg2 }]}>
              <TextInput
                ref={inputRef}
                style={[styles.nameInput, {
                  color: tokens.t1,
                  borderColor: tokens.bdr2,
                  backgroundColor: (tokens as any).inp ?? tokens.bg,
                  fontSize: fs(14),
                }]}
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
              <Pressable onPress={() => { setCreating(false); setNewName('') }} hitSlop={8}>
                <Icon name="xmark" size={15} color={tokens.t3} />
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={[styles.newFolderRow, { borderTopColor: tokens.bdr }]}
              onPress={() => {
                if (!isPro) { onClose(); setTimeout(() => router.push('/paywall'), 200); return }
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
  backdrop: { backgroundColor: 'rgba(0,0,0,0.45)' },
  avoidingView: { flex: 1, justifyContent: 'flex-end' },
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
  createBtn: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  createBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
})
