import { supabase } from '@/lib/supabase'

// RC, 2026-08-11: "make sure any of the other issues or cleanups are taken
// care of fully" -- the advisory-circulars/ac-figures/ac-formula-refs/
// legal-interpretations Storage buckets were public, so the app's own tier
// gating (which correctly nulls pdf_url_cached/image_url in the gated views
// and RPCs for non-eligible tiers) only ever stopped the APP from handing
// out a working link -- anyone with a saved or guessed object URL could
// still fetch the PDF/image bytes directly, no auth at all. Buckets are now
// private; this resolves the STORED "public-style" URL (still written by
// the scrapers unchanged, still the stable identifier used for offline
// caching -- see imageCache.ts) into a short-lived signed URL that actually
// works against a private bucket, minted only if the caller's own session
// passes that bucket's RLS policy (see the has_plus_access()/has_pro_access()
// checks on storage.objects in migrations_gate_storage_buckets.sql).
//
// Deliberately generic -- doesn't hardcode which buckets are gated. Any
// bucket/path parses; whether the signing call actually succeeds is
// entirely down to that bucket's own RLS. A bucket that's still public
// (not yet migrated, or never needs to be) signs successfully too --
// createSignedUrl doesn't require the bucket to be private -- so callers
// don't need to know which buckets are gated versus not.
// The path group deliberately stops at `?` (and `#`): figure/image URLs
// written by the scrapers now carry a `?v=<content-hash>` cache-busting
// marker (see imageCache.ts's versionFor and sync/backfill_aim_pdf_images.py's
// upload_png). This used to be a greedy `(.+)$`, which folded that marker
// INTO the object path -- createSignedUrl would then be asked to sign
// "aim/page-0609.png?v=1a2b3c", an object that does not exist, fail, and
// return null. Since a null here is the "not fetchable" path, every figure
// carrying a version marker would have rendered as a permanent error state.
// Existing marker-less URLs match exactly as before.
const STORAGE_PUBLIC_URL_RE = /\/storage\/v1\/object\/public\/([^/]+)\/([^?#]+)/

// 5 minutes: long enough to cover a slow connection and, on Android,
// pdf-viewer.tsx's own detour through Google's docs.google.com/gview proxy
// (a second server has to fetch the URL too, not just the device) --
// short enough that a copied/shared link is worthless within the hour.
const DEFAULT_EXPIRES_IN_SECONDS = 300

export async function resolveGatedStorageUrl(
  publicStyleUrl: string | null | undefined,
  expiresInSeconds: number = DEFAULT_EXPIRES_IN_SECONDS
): Promise<string | null> {
  if (!publicStyleUrl) return null
  const match = publicStyleUrl.match(STORAGE_PUBLIC_URL_RE)
  // Not a recognized Storage URL (shouldn't happen for these columns, but
  // fail closed rather than pass through something unresolvable as if it
  // were still fetchable) -- null, not the original string.
  if (!match) return null
  const [, bucket, path] = match
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(decodeURIComponent(path), expiresInSeconds)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}
