import * as ImagePicker from 'expo-image-picker'
import { File } from 'expo-file-system'
import * as Crypto from 'expo-crypto'
import { supabase } from '@/lib/supabase'

// Aircraft photo -- Ryan (Suggest a feature, 2026-08-30, submission
// 71a906b7): "allow users to upload an image of their aircraft into the my
// aircraft or my fleet section... utilize the same code that we used in the
// user profile avatars." Deliberately the same shape as avatar.ts end to
// end (same picker options, same upload-raw-bytes-not-fetch-blob technique)
// -- see that file's own comments for why each piece is built the way it is.
// The one real difference: an aircraft has no user_metadata-style JSON
// field to stash a URL on, so the object path lives in user_aircraft.
// image_path instead of a Supabase Auth field (see sync/migrations_
// user_aircraft_image.sql).
//
// That one difference is also why the cache-busting had to diverge from
// avatar.ts, which is where this file originally got it WRONG. avatar.ts
// persists the whole PUBLIC URL, `?t=<upload timestamp>` and all, into auth
// metadata -- so the stored string genuinely changes every time a photo is
// replaced. This file persists only the object PATH and used to re-derive a
// marker from it at read time (`?v=${encodeURIComponent(imagePath)}`), and
// since the upload path was the fixed `<aircraft_id>/photo.jpg`, that marker
// was a CONSTANT: replacing a photo produced a byte-identical URL, so
// nothing downstream could tell the old picture from the new one. Fixed by
// versioning the object path itself -- see uploadAircraftImageAsset.

// sha256 of the exact bytes, hex, truncated to 12 -- the same content-version
// convention the scrapers already use for figure/AD/AIM page images (see
// scripts/extract_figures.py's content_version() and imageCache.ts's
// versionFor). A content hash, NOT a timestamp, for the same reason stated
// there: re-picking the identical photo produces the identical version and
// therefore invalidates nothing, while any genuinely different image moves
// it.
async function contentVersion(bytes: ArrayBuffer): Promise<string> {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

export function getAircraftImageUrl(imagePath: string | null): string | null {
  if (!imagePath) return null
  const { data } = supabase.storage.from('aircraft-images').getPublicUrl(imagePath)
  // No cache-busting query param, on purpose: the version now lives in the
  // object path itself (`<aircraft_id>/photo-<content hash>.jpg`), so the
  // public URL is already unique per image and stays byte-identical while
  // the photo is unchanged. The `?v=${encodeURIComponent(imagePath)}` that
  // used to be appended here was derived entirely from the path, and the
  // path was fixed, so it never varied -- it looked like a cache-buster and
  // busted nothing. Nothing in front of this URL can be relied on to notice
  // a same-URL replacement: the bytes are served with `cache-control:
  // public, max-age=3600` (verified live against the sibling avatars bucket)
  // through Cloudflare (`cf-cache-status: HIT`), and both call sites render
  // with a bare React Native <Image>, which keys iOS's NSURLCache and
  // RCTImageCache on the URL string. Putting the version in the path rather
  // than the query also survives any CDN configured to strip query strings
  // from its cache key.
  return data.publicUrl
}

// `previousPath` is the image_path currently stored on the row (null if the
// aircraft has no photo yet). It exists only so the object it points at can
// be cleaned up: paths used to collide by design (always `photo.jpg`, always
// upsert), so a replacement reclaimed the old object for free. Now that each
// upload lands on its own content-addressed name, a replacement would leave
// the previous object orphaned in Storage forever if nothing deleted it.
// Best-effort -- exactly the reasoning removeAircraftImage already spells
// out: an orphaned object nothing points at is harmless, so a failed cleanup
// must never fail an upload that already succeeded.
async function uploadAircraftImageAsset(aircraftId: string, uri: string, previousPath: string | null): Promise<string> {
  // Same fetch(uri).blob() unreliability workaround as avatar.ts -- read raw
  // bytes directly from the filesystem instead.
  const file = new File(uri)
  const arrayBuffer = await file.arrayBuffer()

  // Hashed off the SAME buffer that is about to be uploaded, not a second
  // read of the file, so the version can never describe bytes other than the
  // ones actually stored.
  const path = `${aircraftId}/photo-${await contentVersion(arrayBuffer)}.jpg`

  // Still upsert: re-picking a byte-identical photo resolves to this same
  // path, and rewriting it is a harmless no-op rather than a conflict.
  const { error: uploadError } = await supabase.storage
    .from('aircraft-images')
    .upload(path, arrayBuffer, { contentType: 'image/jpeg', upsert: true })
  if (uploadError) throw uploadError

  const { error: updateError } = await supabase
    .from('user_aircraft')
    .update({ image_path: path })
    .eq('id', aircraftId)
  if (updateError) throw updateError

  // Only after the row genuinely points at the new object -- deleting first
  // would leave a broken image if the update below it failed.
  if (previousPath && previousPath !== path) {
    await supabase.storage.from('aircraft-images').remove([previousPath]).catch(() => {})
  }

  return path
}

// Opens the photo library, uploads to
// aircraft-images/<aircraftId>/photo-<content hash>.jpg, and saves the
// resulting object path on user_aircraft.image_path. Throws
// 'PERMISSION_DENIED' if photo library access is denied. `onLocalUri`, if
// given, fires with the picked asset's local file:// uri BEFORE the network
// upload starts, so the caller can show it immediately -- same reasoning as
// avatar.ts's own onLocalUri.
export async function pickAndUploadAircraftImage(aircraftId: string, previousPath: string | null, onLocalUri?: (uri: string) => void): Promise<string> {
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
  return uploadAircraftImageAsset(aircraftId, localUri, previousPath)
}

// Same as pickAndUploadAircraftImage but takes a fresh photo instead of
// picking an existing one. Throws 'PERMISSION_DENIED' if camera access is
// denied.
export async function takeAndUploadAircraftImage(aircraftId: string, previousPath: string | null, onLocalUri?: (uri: string) => void): Promise<string> {
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
  return uploadAircraftImageAsset(aircraftId, localUri, previousPath)
}

// Deletes the stored photo object and clears image_path, returning the
// aircraft to its default icon. Takes the stored `imagePath` rather than
// rebuilding it from aircraftId -- the object name is content-addressed now,
// so the row is the only thing that knows which object this aircraft owns.
// A null imagePath means there is no object to delete, and clearing the
// column is still the right thing to do. Storage removal failing (e.g. the
// object was already gone) doesn't block clearing the column -- same
// reasoning as avatar.ts's removeAvatar: a stale Storage object nothing
// points at is harmless, whereas a dangling image_path pointing at a deleted
// file would show a broken image.
export async function removeAircraftImage(aircraftId: string, imagePath: string | null): Promise<void> {
  if (imagePath) {
    await supabase.storage.from('aircraft-images').remove([imagePath]).catch(() => {})
  }
  const { error } = await supabase.from('user_aircraft').update({ image_path: null }).eq('id', aircraftId)
  if (error) throw error
}
