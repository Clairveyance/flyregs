// Which saved aircraft a user's tier actually lets them see, for the
// server-side push senders.
//
// Single shared implementation on purpose. This same rule already exists in
// two other places -- fleet_visible_cap()/get_fleet_summary() in
// sync/migrations_tier_cap_enforcement.sql, and the client re-slice in
// src/app/my-aircraft/index.tsx -- and every push script needs it too. Three
// near-identical hand-rolled copies is exactly how the bookmark-highlight
// bug happened (same matching logic pasted into three files, fixed in one).
// So the scripts share this one, and any future push sender should import it
// rather than re-deriving the rule.
//
// RC, 2026-08-05: "a Pro user would never get a note about 'tracking 4 a/c'
// b/c that's not possible with Pro... we can't have any bleed through" --
// and pushes are the version of that leak that reaches a pocket, so they
// matter most.

// Mirrors PRO_AIRCRAFT_CAP in src/app/my-aircraft/index.tsx and the `else 1`
// branch of fleet_visible_cap(). Keep all three in step.
export const PRO_AIRCRAFT_CAP = 1

// Returns the set of user_aircraft ids that are currently HIDDEN by their
// owner's tier, given every aircraft row and every user_entitlements row.
//
// Rules, identical to the SQL:
//   - Premium: nothing hidden.
//   - No entitlement row at all: nothing hidden. Deliberate fail-open --
//     a sync hiccup must never silently cut off a paying customer's alerts.
//     The client's own RevenueCat check is what covers that window in-app.
//   - Otherwise: keep the oldest PRO_AIRCRAFT_CAP by created_at, hide the
//     rest. Oldest (not newest) so a new save can never bump an existing
//     aircraft out from under its owner.
export function hiddenAircraftIds(allAircraft, entitlements) {
  const isPremiumByUser = new Map((entitlements ?? []).map((e) => [e.user_id, e.is_premium === true]))
  const ownedByUser = new Map()
  for (const a of allAircraft ?? []) {
    if (!ownedByUser.has(a.user_id)) ownedByUser.set(a.user_id, [])
    ownedByUser.get(a.user_id).push(a)
  }
  const hidden = new Set()
  for (const [userId, owned] of ownedByUser) {
    if (!isPremiumByUser.has(userId) || isPremiumByUser.get(userId)) continue
    owned
      .slice()
      .sort((x, y) =>
        String(x.created_at).localeCompare(String(y.created_at)) || String(x.id).localeCompare(String(y.id)))
      .slice(PRO_AIRCRAFT_CAP)
      .forEach((a) => hidden.add(a.id))
  }
  return hidden
}

// Convenience for senders that only need the id set: does both fetches.
export async function fetchHiddenAircraftIds(sb) {
  const [{ data: allAircraft, error: acErr }, { data: entitlements, error: entErr }] = await Promise.all([
    sb.from('user_aircraft').select('id, user_id, created_at'),
    sb.from('user_entitlements').select('user_id, is_premium'),
  ])
  if (acErr) throw new Error(`user_aircraft fetch failed: ${acErr.message}`)
  if (entErr) throw new Error(`user_entitlements fetch failed: ${entErr.message}`)
  return hiddenAircraftIds(allAircraft, entitlements)
}
