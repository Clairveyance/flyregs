// Paged SELECT for the scheduled push senders.
//
// WHY: PostgREST caps a response at the project's max-rows (1000 here) and
// says nothing about it -- no error, no header the client checks, no
// indication more rows exist. A bare `.select()` therefore returns a
// SILENTLY SHORT list, and both senders then iterate that list as if it were
// the whole table.
//
// On the AD path that means: once the fleet passes ~1000 saved aircraft,
// every aircraft past row 1000 stops being matched at all -- no
// user_ad_notifications row, no push, and (per send-ad-alerts.mjs's own
// header) "AD alerts do not retry at all... the ADs in this batch are never
// looked at again." The run then reports success. A truncated
// user_aircraft_equipment or aircraft_collaborators fetch loses matches and
// recipients the same way.
//
// Not reachable at today's scale (4 saved aircraft as of 2026-09-04) -- this
// is a scale-triggered SILENT miss on a safety-relevant path, fixed before it
// can happen rather than after. Same 1000-row cap already documented in
// memory/gotcha_postgrest_1000_row_cap.
//
// `.order('id')` is deliberate and not optional: without a stable sort the
// page boundaries are unspecified, so paging can both duplicate and skip rows.
// Callers whose table has no `id` pass an explicit orderBy.
export async function selectAll(sb, table, columns, { tune = (q) => q, orderBy = 'id' } = {}) {
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await tune(sb.from(table).select(columns))
      .order(orderBy)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table} fetch failed: ${error.message}`)
    rows.push(...data)
    if (data.length < PAGE) return rows
  }
}
