import AsyncStorage from '@react-native-async-storage/async-storage'
import { syncPushFolder, syncPushFolderDelete, syncPushFolderItems, syncPushFolderItemDeletes } from '@/lib/syncPush'
import { unshareFolder } from '@/lib/sharedFolders'

const FOLDERS_KEY = '@flyregs/folders'
const FOLDER_ITEMS_KEY = '@flyregs/folder_items'

export interface Folder {
  id: string
  name: string
  created_at: string
  updated_at: string
}

export interface FolderItem {
  id: string
  folder_id: string
  item_type: 'ac' | 'note'
  item_id: string
  added_at: string
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

// ── Folders ───────────────────────────────────────────────────────────────────

export async function getFolders(): Promise<Folder[]> {
  try {
    const raw = await AsyncStorage.getItem(FOLDERS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export async function createFolder(name: string): Promise<Folder> {
  const folders = await getFolders()
  const now = new Date().toISOString()
  const folder: Folder = { id: makeId(), name: name.trim(), created_at: now, updated_at: now }
  await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify([...folders, folder]))
  syncPushFolder(folder)
  return folder
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const folders = await getFolders()
  const updated_at = new Date().toISOString()
  const next = folders.map((f) => (f.id === id ? { ...f, name: name.trim(), updated_at } : f))
  await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(next))
  const renamed = next.find((f) => f.id === id)
  if (renamed) syncPushFolder(renamed)
}

export async function deleteFolder(id: string): Promise<void> {
  const [folders, items] = await Promise.all([getFolders(), getFolderItems()])
  const itemsInFolder = items.filter((i) => i.folder_id === id)
  await Promise.all([
    AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(folders.filter((f) => f.id !== id))),
    AsyncStorage.setItem(FOLDER_ITEMS_KEY, JSON.stringify(items.filter((i) => i.folder_id !== id))),
  ])
  syncPushFolderDelete(id)
  syncPushFolderItemDeletes(itemsInFolder.map((i) => i.id))
  // Deleting a folder should also drop anyone it was shared with -- otherwise
  // stale folder_collaborators rows linger forever with no owning folder.
  unshareFolder(id).catch(() => {})
}

// ── Folder items ──────────────────────────────────────────────────────────────

export async function getFolderItems(): Promise<FolderItem[]> {
  try {
    const raw = await AsyncStorage.getItem(FOLDER_ITEMS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export async function getItemsInFolder(folderId: string): Promise<FolderItem[]> {
  const items = await getFolderItems()
  return items.filter((i) => i.folder_id === folderId)
}

export async function getFoldersForItem(itemType: 'ac' | 'note', itemId: string): Promise<string[]> {
  const items = await getFolderItems()
  return items
    .filter((i) => i.item_type === itemType && i.item_id === itemId)
    .map((i) => i.folder_id)
}

export async function addToFolder(
  folderId: string,
  itemType: 'ac' | 'note',
  itemId: string
): Promise<void> {
  return addManyToFolder(folderId, itemType, [itemId])
}

// Adds several items to a folder in one read-modify-write. Calling addToFolder
// in a Promise.all loop is unsafe — each call reads the same pre-write snapshot
// of AsyncStorage, so concurrent writes clobber each other and only the last
// item survives. This does the read once, adds everything, writes once.
export async function addManyToFolder(
  folderId: string,
  itemType: 'ac' | 'note',
  itemIds: string[]
): Promise<void> {
  const items = await getFolderItems()
  const existing = new Set(
    items
      .filter((i) => i.folder_id === folderId && i.item_type === itemType)
      .map((i) => i.item_id)
  )
  const now = new Date().toISOString()
  const newItems: FolderItem[] = itemIds
    .filter((itemId) => !existing.has(itemId))
    .map((itemId) => ({
      id: makeId(),
      folder_id: folderId,
      item_type: itemType,
      item_id: itemId,
      added_at: now,
    }))
  if (newItems.length === 0) return
  await AsyncStorage.setItem(FOLDER_ITEMS_KEY, JSON.stringify([...items, ...newItems]))
  syncPushFolderItems(newItems)
}

export async function removeFromFolder(
  folderId: string,
  itemType: 'ac' | 'note',
  itemId: string
): Promise<void> {
  const items = await getFolderItems()
  const removed = items.filter(
    (i) => i.folder_id === folderId && i.item_type === itemType && i.item_id === itemId
  )
  await AsyncStorage.setItem(
    FOLDER_ITEMS_KEY,
    JSON.stringify(items.filter((i) => !removed.some((r) => r.id === i.id)))
  )
  syncPushFolderItemDeletes(removed.map((i) => i.id))
}

/** Returns a map of folderId → item count, useful for rendering folder cards. */
export async function getFolderItemCounts(): Promise<Record<string, number>> {
  const items = await getFolderItems()
  const counts: Record<string, number> = {}
  for (const item of items) {
    counts[item.folder_id] = (counts[item.folder_id] ?? 0) + 1
  }
  return counts
}
