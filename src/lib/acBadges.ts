import { supabase } from '@/lib/supabase'

// AC badge data, looked up by whichever identifier the caller happens to hold.
//
// THE BUG THIS EXISTS TO FIX (found 2026-09-17 by watching real API failures
// while using the app):
//
//     400 GET advisory_circulars_gated
//     invalid input syntax for type uuid: "61-65K"
//
// An AC saved from a list is stored with its DOCUMENT NUMBER as its id
// (`ac_id: "61-65K"`), while an AC highlighted inside a document is stored with
// the real row UUID. Four screens -- Saved, Recents, Folder and Shared Folder --
// each built an id list and sent all of it to `.in('id', ids)`. One document
// number in that list makes the WHOLE query 400, and every one of those four
// call sites read the result as `.then(({ data }) => ...)` with no error branch,
// so the failure became an empty badge map.
//
// The visible symptom is not an error. It is that every saved AC silently loses
// its NEW / UPD / VER badge -- for ALL of them, because one bad id kills the
// whole batch. Which is the exact symptom, on the exact screens, that a
// 2026-08-23 fix already chased once when the cause was a missing column grant.
// Second time, different cause, same silent shape.
//
// So the lookup is done ONCE, here, instead of being open-coded four times:
//  * ids are split -- real UUIDs queried by `id`, everything else by
//    `document_number` -- so a mixed list can no longer poison the batch;
//  * the result is keyed by BOTH the row's uuid and its document_number, so a
//    caller looks up with whatever it has and does not need to know which;
//  * an error is RETURNED, not swallowed, so a caller can tell "no badges" from
//    "the lookup failed".

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AcBadgeRow {
  id: string
  document_number: string
  title?: string | null
  /** Never null: a row that cancels nothing gets [], which is what every
   *  consumer already assumed when this was open-coded. */
  cancels: string[]
  changed_block_indices: number[] | null
  date_issued: string | null
}

export type AcBadgeMap = Record<string, AcBadgeRow>

const COLUMNS = 'id, document_number, title, cancels, changed_block_indices, date_issued'

/**
 * Badge data for a mixed list of AC identifiers (row UUIDs, document numbers,
 * or both). Returns a map addressable by either.
 */
export async function fetchAcBadgeData(
  rawIds: string[],
): Promise<{ map: AcBadgeMap; error: string | null }> {
  const ids = [...new Set(rawIds.filter(Boolean))]
  if (ids.length === 0) return { map: {}, error: null }

  const uuids = ids.filter((i) => UUID_RE.test(i))
  const docNumbers = ids.filter((i) => !UUID_RE.test(i))

  const queries: Promise<{ data: any[] | null; error: { message: string } | null }>[] = []
  if (uuids.length) {
    queries.push(
      supabase.from('advisory_circulars_gated').select(COLUMNS).in('id', uuids) as any,
    )
  }
  if (docNumbers.length) {
    queries.push(
      supabase.from('advisory_circulars_gated').select(COLUMNS).in('document_number', docNumbers) as any,
    )
  }

  const results = await Promise.all(queries)
  const map: AcBadgeMap = {}
  let error: string | null = null
  for (const r of results) {
    // One leg failing must not discard the other leg's rows -- a partial badge
    // map beats none, and the error still comes back so the caller knows.
    if (r.error) { error = r.error.message; continue }
    for (const row of r.data ?? []) {
      const normalised: AcBadgeRow = { ...row, cancels: row.cancels ?? [] }
      map[row.id] = normalised
      if (row.document_number) map[row.document_number] = normalised
    }
  }
  return { map, error }
}
