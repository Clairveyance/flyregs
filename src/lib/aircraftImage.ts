import * as ImagePicker from 'expo-image-picker'
import { File } from 'expo-file-system'
import { supabase } from '@/lib/supabase'

// Aircraft photo -- Ryan (Suggest a feature, 2026-08-30, submission
// 71a906b7): "allow users to upload an image of their aircraft into the my
// aircraft or my fleet section... utilize the same code that we used in the
// user profile avatars." Deliberately the same shape as avatar.ts end to
// end (same picker options, same upload-raw-bytes-not-fetch-blob technique,
// same upsert-at-a-fixed-path pattern, same cache-busting query param) --
// see that file's own comments for why each piece is built the way it is.
// The one real difference: an aircraft has no user_metadata-style JSON
// field to stash a URL on, so the object path lives in user_aircraft.
// image_path instead of a Supabase Auth field (see sync/migrations_
// user_aircraft_image.sql).

export function getAircraftImageUrl(imagePath: string | null): string | null {
  if (!imagePath) return null
  const { data } = supabase.storage.from('aircraft-images').getPublicUrl(imagePath)
  // Cache-bust: the path is stable across re-uploads (always <id>/photo.jpg),
  // so without this a client that already fetched the old photo would keep
  // showing it after a replacement -- same reasoning as avatar.ts's
  // uploadAvatarAsset. Bust on the path's own identity, not Date.now(): a
  // component re-rendering with the SAME still-current path shouldn't
  // re-fetch on every render, only when the path (and therefore likely the
  // underlying image) actually changes -- Date.now() would defeat any image
  // cache on every single render instead.
  return `${data.publicUrl}?v=${encodeURIComponent(imagePath)}`
}

async function uploadAircraftImageAsset(aircraftId: string, uri: string): Promise<string> {
  const path = `${aircraftId}/photo.jpg`

  // Same fetch(uri).blob() unreliability workaround as avatar.ts -- read raw
  // bytes directly from the filesystem instead.
  const file = new File(uri)
  const arrayBuffer = await file.arrayBuffer()

  const { error: uploadError } = await supabase.storage
    .from('aircraft-images')
    .upload(path, arrayBuffer, { contentType: 'image/jpeg', upsert: true })
  if (uploadError) throw uploadError

  const { error: updateError } = await supabase
    .from('user_aircraft')
    .update({ image_path: path })
    .eq('id', aircraftId)
  if (updateError) throw updateError

  return path
}

// Opens the photo library, uploads to aircraft-images/<aircraftId>/photo.jpg
// (upsert -- re-picking just replaces it), and saves the resulting object
// path on user_aircraft.image_path. Throws 'PERMISSION_DENIED' if photo
// library access is denied. `onLocalUri`, if given, fires with the picked
// asset's local file:// uri BEFORE the network upload starts, so the caller
// can show it immediately -- same reasoning as avatar.ts's own onLocalUri.
export async function pickAndUploadAircraftImage(aircraftId: string, onLocalUri?: (uri: string) => void): Promise<string> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!perm.granted) throw new Error('PERMISSION_DENIED')

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [4, 3],
    quality: 0.7,
  })
  if (result.canceled || !result.assets?.[0]) throw new Error('CANCELLED')

  const localUri = result.assets[0].uri
  onLocalUri?.(localUri)
  return uploadAircraftImageAsset(aircraftId, localUri)
}

// Same as pickAndUploadAircraftImage but takes a fresh photo instead of
// picking an existing one. Throws 'PERMISSION_DENIED' if camera access is
// denied.
export async function takeAndUploadAircraftImage(aircraftId: string, onLocalUri?: (uri: string) => void): Promise<string> {
  const perm = await ImagePicker.requestCameraPermissionsAsync()
  if (!perm.granted) throw new Error('PERMISSION_DENIED')

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [4, 3],
    quality: 0.7,
  })
  if (result.canceled || !result.assets?.[0]) throw new Error('CANCELLED')

  const localUri = result.assets[0].uri
  onLocalUri?.(localUri)
  return uploadAircraftImageAsset(aircraftId, localUri)
}

// Deletes the stored photo object and clears image_path, returning the
// aircraft to its default icon. Storage removal failing (e.g. the object
// was already gone) doesn't block clearing the column -- same reasoning as
// avatar.ts's removeAvatar: a stale Storage object nothing points at is
// harmless, whereas a dangling image_path pointing at a deleted file would
// show a broken image.
export async function removeAircraftImage(aircraftId: string): Promise<void> {
  const path = `${aircraftId}/photo.jpg`
  await supabase.storage.from('aircraft-images').remove([path]).catch(() => {})
  const { error } = await supabase.from('user_aircraft').update({ image_path: null }).eq('id', aircraftId)
  if (error) throw error
}
