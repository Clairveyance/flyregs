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

export const PRO_AIRCRAFT_CAP = 1
const UNCAPPED = Number.MAX_SAFE_INTEGER

// The tier ladder, per RC 2026-08-05: "first Plus tier has no a/c... If
// going Pro>Prem then you take your a/c w/ you and then just add more. if
// going Prem>Pro, then we can't pay to 'store' anything for Pro users."
// So Free and Plus get NONE, Pro gets exactly one, Premium is unlimited.
// Mirrors fleet_visible_cap() in
// sync/migrations_tier_cap_enforcement.sql and AIRCRAFT_CAP_FOR_TIER in
// src/app/my-aircraft/index.tsx -- keep all three in step.
export function aircraftCapFor(entitlement) {
  if (!entitlement) return UNCAPPED   // no row at all -> fail open, see below
  if (entitlement.is_premium) return UNCAPPED
  if (entitlement.is_pro) return PRO_AIRCRAFT_CAP
  return 0
}

// Returns the set of user_aircraft ids currently LOCKED by their owner's
// tier, given every aircraft row and every user_entitlements row.
//
// ALL-OR-NOTHING, matching get_fleet_summary()'s `visible` CTE. RC,
// 2026-08-05: "ALL their Prem a/c are 'locked out' until they make this
// choice, during the d/g process." An account over its cap goes fully
// quiet -- no pushes for any of its aircraft -- until the user picks which
// one they're keeping. Half-alerting from an arbitrarily-chosen survivor
// would be worse than silence: it looks like the others stopped mattering.
//
// A MISSING entitlement row locks nothing, deliberately -- a sync hiccup
// must never silently cut off a paying customer's alerts. The client's own
// RevenueCat check is what covers that window in-app.
export function hiddenAircraftIds(allAircraft, entitlements) {
  const entByUser = new Map((entitlements ?? []).map((e) => [e.user_id, e]))
  const ownedByUser = new Map()
  for (const a of allAircraft ?? []) {
    if (!ownedByUser.has(a.user_id)) ownedByUser.set(a.user_id, [])
    ownedByUser.get(a.user_id).push(a)
  }
  const locked = new Set()
  for (const [userId, owned] of ownedByUser) {
    if (owned.length <= aircraftCapFor(entByUser.get(userId))) continue
    owned.forEach((a) => locked.add(a.id))
  }
  return locked
}

// Users whose tier includes AD push notifications at all. RC, 2026-08-05:
// "Pro would have to open the app and check their My Aircraft page to see
// the status of ADs. Their Reminders can push, b/c that's their own
// schedule making essentially... AD alerts are only pushed to Prem."
// Note this is about the PUSH only -- user_ad_notifications rows are still
// written for Pro, which is what makes the in-app status they check real.
export function canReceiveAdPush(entitlement) {
  if (!entitlement) return true   // fail open, same reasoning as the cap
  return entitlement.is_premium === true
}

// Convenience for senders that only need the id set: does both fetches.
export async function fetchHiddenAircraftIds(sb) {
  const [{ data: allAircraft, error: acErr }, { data: entitlements, error: entErr }] = await Promise.all([
    sb.from('user_aircraft').select('id, user_id, created_at'),
    sb.from('user_entitlements').select('user_id, is_pro, is_premium'),
  ])
  if (acErr) throw new Error(`user_aircraft fetch failed: ${acErr.message}`)
  if (entErr) throw new Error(`user_entitlements fetch failed: ${entErr.message}`)
  return hiddenAircraftIds(allAircraft, entitlements)
}

// Users whose tier includes the PRO-tier push features: DailyReg and AC
// Update Alerts. Both are Pro in the product, and both push senders were
// sending on the OPT-IN FLAG ALONE -- `push_tokens.reg_of_day_enabled` /
// `push_tokens.enabled` -- with no entitlement check anywhere.
//
// That's the classic "clung on after the downgrade" leak, and it's the
// version that reaches a pocket: subscribe to Pro, switch both alerts on,
// let the subscription lapse. The webhook correctly flips is_pro to false,
// but nothing ever touches push_tokens, so the notifications keep arriving
// indefinitely. Found in the pre-beta gating audit; send-ad-alerts.mjs and
// send-reminder-alerts.mjs already enforced tier, these two didn't, which
// is the usual shape -- one shared rule, drifted call sites.
//
// Fail-open on a missing entitlement row, identical reasoning to
// aircraftCapFor/canReceiveAdPush above: a sync hiccup must not silently
// cut off a paying customer's alerts, and the client's own RevenueCat check
// covers that window.
export function canReceiveProPush(entitlement) {
  if (!entitlement) return true
  return Boolean(entitlement.is_pro || entitlement.is_premium)
}
