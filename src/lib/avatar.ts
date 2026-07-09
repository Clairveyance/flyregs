import * as ImagePicker from 'expo-image-picker'
import { File } from 'expo-file-system'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

// Profile photo — available to any signed-in user (not tier-gated itself),
// but it only actually becomes visible to anyone else when Premium sharing
// includes it on a shared card (see src/lib/shareCard.ts).

export function getAvatarUrl(session: Session | null): string | null {
  return (session?.user?.user_metadata as { avatar_url?: string } | undefined)?.avatar_url ?? null
}

export function getDisplayName(session: Session | null): string {
  const metaName = (session?.user?.user_metadata as { display_name?: string } | undefined)?.display_name
  if (metaName) return metaName
  const email = session?.user?.email
  return email ? email.split('@')[0] : 'A FlyRegs user'
}

async function uploadAvatarAsset(userId: string, uri: string): Promise<string> {
  const path = `${userId}/avatar.jpg`

  // Read the picked/captured photo's raw bytes directly from the filesystem
  // rather than `fetch(uri).blob()` — React Native's fetch/Blob polyfill is
  // unreliable for local file:// URIs (can silently produce an empty or
  // corrupt blob depending on device/OS version), a well-documented gotcha
  // for Supabase Storage uploads from Expo apps. `File.arrayBuffer()` reads
  // the real bytes natively, avoiding that layer entirely.
  const file = new File(uri)
  const arrayBuffer = await file.arrayBuffer()

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, arrayBuffer, { contentType: 'image/jpeg', upsert: true })
  if (uploadError) throw uploadError

  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  // Cache-bust: the path never changes when a user replaces their photo, so
  // without this, clients (including whoever a card gets shared to) would
  // keep showing a cached copy of the OLD image indefinitely.
  const publicUrl = `${data.publicUrl}?t=${Date.now()}`

  const { error: updateError } = await supabase.auth.updateUser({ data: { avatar_url: publicUrl } })
  if (updateError) throw updateError

  return publicUrl
}

// Opens the photo library, uploads the chosen image to the "avatars" Storage
// bucket at <user_id>/avatar.jpg (upsert — always the same path, so re-picking
// just replaces it), and saves the resulting public URL to the user's own
// auth metadata. Throws 'PERMISSION_DENIED' if photo library access is denied.
export async function pickAndUploadAvatar(userId: string): Promise<string> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!perm.granted) throw new Error('PERMISSION_DENIED')

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.7,
  })
  if (result.canceled || !result.assets?.[0]) throw new Error('CANCELLED')

  return uploadAvatarAsset(userId, result.assets[0].uri)
}

// Same as pickAndUploadAvatar but takes a fresh photo instead of picking an
// existing one. Throws 'PERMISSION_DENIED' if camera access is denied.
export async function takeAndUploadAvatar(userId: string): Promise<string> {
  const perm = await ImagePicker.requestCameraPermissionsAsync()
  if (!perm.granted) throw new Error('PERMISSION_DENIED')

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.7,
  })
  if (result.canceled || !result.assets?.[0]) throw new Error('CANCELLED')

  return uploadAvatarAsset(userId, result.assets[0].uri)
}
