import { useState, useRef, useEffect, useCallback } from 'react'
import Reanimated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing, useReducedMotion, interpolateColor,
} from 'react-native-reanimated'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Modal, KeyboardAvoidingView, Platform } from 'react-native'
import { router, useFocusEffect, useIsFocused } from 'expo-router'
import { useTheme, type ThemeTokens } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useConfirm } from '@/components/ConfirmDialog'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { TabletContainer } from '@/components/TabletContainer'
import { supabase } from '@/lib/supabase'
import { suggestTypeDesignator } from '@/lib/aircraftModels'
import { backfillAircraftAds, getAircraftAdNotifications, markAdComplied, unmarkAdComplied, type AircraftAdNotification } from '@/lib/adNotifications'
import { getAircraftReminders, type AircraftReminder } from '@/lib/adParts'
import {
  getFleetSummary,
  type FleetAircraftSummary,
} from '@/lib/aircraftSharing'
import { SwipeToDelete } from '@/components/SwipeToDelete'
import { HobbsUpdateModal } from '@/components/HobbsUpdateModal'
import {
  MakeField, ModelField, TypeDesignatorField, YearField, YearPickerModal, type UserAircraft,
} from '@/components/AircraftFormFields'

// The actual payoff of the AD expansion, per explicit direction: a pilot/
// owner/mechanic only cares about the ~15-20 ADs issued per week that touch
// an aircraft they actually fly, not a firehose across the full 17,000+
// corpus. This lightweight make/model list (not a full N-number/registry
// lookup — deliberately kept simple) is what a future AD-alerts job matches
// new/updated ADs against.
//
// 2026-07-28: this screen became a list->detail pair (index.tsx here,
// [id].tsx for one aircraft) so equipment tags and reminders -- both
// Premium, see flyregs_decisions.md's AD Compliance-Tracking Scope
// Decision -- have somewhere to live per-aircraft, matching this app's
// existing list/detail pattern everywhere else (folders, Ref Packets,
// etc.) rather than cramming both into this list screen.
// Matches my-aircraft/[id].tsx's own daysUntil exactly.
function daysUntil(dateStr: string): number {
  const due = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - now.getTime()) / 86400000)
}

// Pro: 1 saved aircraft (most owners have exactly one). Premium: unlimited --
// a natural upsell for shops/mechanics tracking a fleet. See the pricing
// pivot's aircraft-cap decision in flyregs_decisions.md. Sharing (viewing or
// editing someone else's aircraft) has no separate cap of its own -- RC:
// "My Fleet is a Prem only feature, so there is no a/c cap" -- but every
// collaborator, not just the owner, needs their own Premium subscription
// (enforced in handleJoin below), the same client-side pattern used
// everywhere else in this app (folders, equipment, reminders).
const PRO_AIRCRAFT_CAP = 1

// The saved-aircraft ladder, per RC 2026-08-05: "first Plus tier has no
// a/c. Then, if a/c storage is server backed, then that's our cost and for
// that, accounts must be on Prem. If going Pro>Prem then you take your a/c
// w/ you and then just add more. if going Prem>Pro, then we can't pay to
// 'store' anything for Pro users. in this case, they'd have to choose 1 a/c
// to take w/ them down to Pro." Mirrors fleet_visible_cap() in
// sync/migrations_tier_cap_enforcement.sql and aircraftCapFor() in
// scripts/lib/tier-cap.mjs -- keep all three in step.
function aircraftCapForTier(isPro: boolean, isPremium: boolean): number {
  if (isPremium) return Number.MAX_SAFE_INTEGER
  if (isPro) return PRO_AIRCRAFT_CAP
  return 0
}

// RC: "the whole colorful design with the wheel. none of it shows up,
// anywhere" -- the compliance ring from the Fleet mockup was approved but
// never actually built into this real screen. Then, after a first pass
// reused the app's existing plain-color-badge pattern (study.tsx's mastery
// ring): "no, don't try to build using old parts - the Fleet page and
// wheel look distinctly diff from anything else we have. use this image as
// ref" -- a real multi-segment proportional donut, not a solid-color badge.
// react-native-svg isn't in this project (checked node_modules and the
// lockfile directly, not assumed) -- adding it now would need a fresh
// native build to actually appear on-device, the exact problem this whole
// round has been about. So this is built from RING_TICKS discrete radial
// segments instead of a continuous SVG arc: each tick is a small bar
// inside its own full-size wrapper View, positioned at that wrapper's own
// top-center (12 o'clock) via alignItems, then the WRAPPER is rotated by
// the tick's angle -- rotation pivots around the wrapper's center, which
// coincides with the ring's center since the wrapper is the same size and
// position as the ring, so this sweeps the tick to the right spot with no
// per-tick trigonometry. Standard SVG-free technique for radial layouts.
// RC: "the main ring can take up more of that open space" once the AD
// legend became two compact stat boxes instead of a wider dot-row list --
// grown from 152 (no other tick/tap-target math depends on this beyond the
// wrapper size RingTick's absoluteFill already scales to, per its own
// comment above).
const RING_SIZE = 176
const RING_TICKS = 32

// RC, after the two-pill chase read as basically invisible even at a
// stronger dim: "let's try this instead -- one main pill, it moves slow
// around the ring, but every 6 seconds it breathes and sends out a
// shockwave that ripples through the other pills, all the way around and
// back into the main pill. that ripple should complete in about a second."
//
// One slow-moving position (mainPos) shown as a resting dim on whichever
// tick it currently sits near. Every RIPPLE_PERIOD_MS, the main pill does a
// quick breathe (a scale bump, reusing the same sine in/out idea as the Pro
// hero ring's breathe) and launches a ripple: a second position that starts
// at the main pill's CURRENT spot and sweeps one full lap (RING_TICKS) in
// RIPPLE_DURATION_MS, ending back where it started -- "back into the main
// pill" falls out naturally from a full lap of a circle.
// RC, after seeing the first pass live: 3x the main pill's speed, a bigger
// breathe, the main pill visibly still moving through the ripple (not just
// mechanically still moving -- see below), the ripple felt as a passing
// BULGE on each pill rather than a dim, the ripple itself 2x slower, and an
// overall "reverberation" quality rather than a single clean pulse.
//
// The ripple switched from opacity (dim) to scale (bulge) entirely -- this
// is what actually solves "main pill keeps moving even as it ripples":
// mainPos's own drift never paused in the first version either, but sharing
// the same dim visual language with the ripple made the two impossible to
// tell apart at a glance. Separating them onto different visual channels
// (main pill = opacity dim, ripple = scale bulge) makes both readable at
// once instead of just one blob.
const RING_STEP_MS = 250
const MAIN_SPEED = 1.2 // ticks/sec -- 3x the original 0.4
const MAIN_FALLOFF_TICKS = 1.0
const MAIN_MAX_DIM = 0.55
// RC: "make the main pill breathe BEFORE releasing the ripple, as if it
// takes a big breath and exhales the large ripple" -- lengthened the inhale
// itself (350->550ms) so the hold reads as deliberate, not a quick flicker,
// and the interval below now sequences inhale-THEN-release instead of
// firing both at once (see that effect's own comment for why).
const BREATHE_MS = 550
const BREATHE_AMOUNT = 0.7 // up from 0.35 -- a much more obvious inhale
const RIPPLE_PERIOD_MS = 6000
// RC: "go back to the previous speed, cancel that 2x slowdown -- looks
// better the other way." Back to 2000 (was briefly 4000 this session).
const RIPPLE_DURATION_MS = 2000
const RIPPLE_BULGE_MAX = 0.55 // peak scale bump right as the wavefront passes a tick
// RC: "you have a sort of 'dual ripple', a second pill sort of chasing the
// ripple, a few pills behind." Root cause: the old formula multiplied the
// exponential decay by a COSINE wobble term, which is periodic -- it doesn't
// just fade once, it swings back into positive territory a second time
// (at ticksBehind = 2*RIPPLE_WOBBLE_TICKS), producing a genuine second,
// separate bump inside the still-visible decay window. That second bump IS
// the "chaser" RC saw, not a bug in perception. Fixed by dropping the
// oscillation entirely -- pure exponential decay from the moment the
// wavefront passes, so there is exactly ONE bulge per tick, fading smoothly,
// never re-brightening.
const RIPPLE_DECAY_TICKS = 3.5
// The wavefront position (ripplePhase * RING_TICKS + origin) keeps advancing
// past a full lap (phase > 1) so ticks passed right at the END of the sweep
// -- the ones nearest the main pill's own position -- still get to finish
// ringing out instead of being cut off the instant phase hits 1.
const RIPPLE_TAIL = (RIPPLE_DECAY_TICKS * 2.5) / RING_TICKS
// RC: "make sure the ripple goes all the way around, beyond 360 degrees, to
// catch back up to the Main pill, which is continuing to move. Right now the
// ripple terminates at the spot where the main pill USED to be." A flat
// 1-lap sweep (the old behavior) always lands exactly back on rippleOrigin,
// but rippleOrigin is a snapshot frozen at the moment of exhale -- mainPos
// keeps drifting the whole time the ripple is traveling, so by the time the
// wave finishes its lap the real main pill has already moved a couple ticks
// further on. This is a classic pursuit problem (a wave chasing a target
// that started at the same spot and keeps moving the same direction): the
// wave has to travel slightly MORE than one full lap to actually re-meet the
// live main pill, not just return to where it launched from.
//
// Solving it: the wave's own angular speed is fixed by design at
// RING_TICKS ticks per RIPPLE_DURATION_MS (that's what "one lap in about N
// ms" means). Closing speed on the moving target = (wave speed - main pill's
// speed); the distance to close, in ticks, is one full lap (RING_TICKS) plus
// however far the target has moved by the time it's caught, which resolves
// to LAPS_TO_CATCH = waveSpeed / (waveSpeed - MAIN_SPEED) lap-units (algebra
// below) -- with the current constants this is ~1.08 laps, i.e. the wave
// only needs to run a little past 360 degrees, not double the sweep.
// Assumes waveSpeed > MAIN_SPEED (true by a wide margin with these
// constants) -- otherwise the wave could never catch a target moving faster
// than it.
const RIPPLE_WAVE_SPEED_TICKS_PER_SEC = (RING_TICKS * 1000) / RIPPLE_DURATION_MS
const RIPPLE_LAPS_TO_CATCH = RIPPLE_WAVE_SPEED_TICKS_PER_SEC / (RIPPLE_WAVE_SPEED_TICKS_PER_SEC - MAIN_SPEED)

// RC: "the whole ring should give off this slow 'heat wave' feel... but you
// have to add this effect to each pill individually and randomly. they all
// kind of randomly shimmer, glow, and bulge subtly, in a very random way."
// Explicitly NOT a single coordinated wave -- RC also asked to remove the
// "big colored circle" ambient halo this session's first attempt added
// behind the whole ring. Heat now lives ENTIRELY at the per-tick level (see
// RingTick's own shimmer effect below): each of the 32 ticks runs its own
// independent, randomly-timed glow/bulge loop, unsynchronized with every
// other tick and with the main pill/ripple mechanic. A fixed warm
// engine-heat orange, independent of theme/red-shift -- heat reads as heat
// in any theme, same reasoning as the FigureViewer's fixed white/black
// chrome.
const HEAT_COLOR = '#ff7a1a'
const HEAT_SHIMMER_MIN_DELAY_MS = 1500
const HEAT_SHIMMER_MAX_DELAY_MS = 5000
// RC, after seeing it live with the ambient halo removed: "lessen the size
// of the bulges on all the random pills... none of them should really
// stand out, they should all just kind of be alive." The main pill's own
// breathe bulge (BREATHE_AMOUNT above) was fine as-is -- this is about the
// per-tick shimmer specifically standing out too much. Two changes: lowered
// the peak range itself, AND decoupled the shimmer's contribution to the
// physical scale bulge from its contribution to the color glow (see
// HEAT_SHIMMER_SCALE_WEIGHT below) -- the glow can still swing through its
// full range so the ring reads as genuinely warm, while the visible bulge
// per pill stays small enough that no single pill ever pops out of the ring.
//
// RC, next round: "you took a bit too much away from the heat effects for
// all the pills -- put a little bit of movement, sizing back." Nudged the
// peak range and the scale weight both back up partway (not all the way to
// the original 0.15-0.45/1.0, which is what stood out too much in the first
// place) -- a middle ground with real, visible movement per pill without
// reintroducing the "look at me" bulge.
const HEAT_SHIMMER_MIN_PEAK = 0.14
const HEAT_SHIMMER_MAX_PEAK = 0.38
const HEAT_SHIMMER_MIN_DURATION_MS = 500
const HEAT_SHIMMER_MAX_DURATION_MS = 1100
// Only this fraction of heatShimmer.value shows up as a scale bulge; the
// full value still drives the color blend below. Keeps the "alive" glow
// visible without the bulge itself standing out.
const HEAT_SHIMMER_SCALE_WEIGHT = 0.55
function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

// RC: "you also need to test this with multiple a/c, and with the ring
// having multiple colors -- this entire effect should be color independent."
// It wasn't: interpolateColor blends linearly in RGB from a tick's OWN
// status color toward the fixed HEAT_COLOR, so the perceived shift at the
// same heatIntensity value depends entirely on how far that status color
// already sits from HEAT_COLOR in RGB space. Amber (#F59E0B) sits very close
// to the heat orange (#ff7a1a) -- a real distance of ~40 -- so amber pills
// barely visibly warm up. Green (#34D399) sits far away (~255 distance), so
// green pills swing dramatically for the exact same intensity value. Red
// lands in between (~70). Rather than rework the whole blend into HSL space,
// DAMP each tick's heatIntensity by a factor proportional to its own color's
// distance from HEAT_COLOR, so heatIntensity * weight * distance -- the
// actual RGB distance actually traveled -- tops out around the same
// HEAT_TARGET_SHIFT no matter which status color a tick starts from. Capped
// at 1.0 (never amplifies): an early version multiplied amber/red's
// distance UP past 1x to try to equalize them with green, but live
// DOM-sampling showed that made amber/red pills snap all the way to solid
// HEAT_COLOR the moment heatIntensity crossed a low threshold -- a visible
// "pop," not a smooth shift, and the opposite of "none of them should stand
// out." Amber and red already sit close enough to HEAT_COLOR that their
// natural (unweighted) shift is small and safe on its own; only green needs
// real damping. Live-sampled with a mixed 3-color ring (a real green/amber/
// red split, not just the usual 2-color fleet): at 90, green's own damped
// ceiling still landed noticeably above red's natural ~70 and well above
// amber's natural ~40. Lowered to 45 so green's ceiling sits between the
// two instead of above both -- all three now read as comparably "warm" at
// their peak instead of green visibly out-pulsing its neighbors.
const HEAT_TARGET_SHIFT = 45
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgbDistance(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}
function heatWeightFor(color: string): number {
  return Math.min(1, HEAT_TARGET_SHIFT / Math.max(1, rgbDistance(color, HEAT_COLOR)))
}

function FleetRing({
  compliantCount, openCount, overdueCount, aircraftTotal, tokens, fs,
}: {
  // RC, real device: "the count up top isn't matching how many open/
  // compliant ADs there are... 12 open and 3 complied ADs, but the top
  // numbers don't match at all." These three were previously AIRCRAFT
  // counts (how many aircraft fall into each bucket, by worst status) --
  // correct by that definition, but not what the numbers next to them look
  // like they mean, and degenerate with a 1-aircraft fleet (always 0 or 1
  // regardless of how many real ADs that aircraft has). Now real item-level
  // sums across the fleet -- open AD count, compliant AD count, overdue
  // REMINDER count (ADs don't have their own separate "overdue" state in
  // this schema, only reminders do) -- matching the stat boxes below and
  // the Applicable ADs list's own checkmarks exactly. aircraftTotal (fleet
  // size) stays a separate, deliberately different number, still shown at
  // the ring's own center -- see below.
  compliantCount: number; openCount: number; overdueCount: number; aircraftTotal: number
  tokens: ThemeTokens; fs: (n: number) => number
}) {
  // Proportional split is now over the item total (how many AD/reminder
  // things have a status at all), not aircraft count -- the ring's own
  // colored dial should visually match the legend numbers sitting right
  // next to it, not a different metric entirely.
  const itemTotal = compliantCount + openCount + overdueCount
  const nOverdue = itemTotal > 0 ? Math.round((overdueCount / itemTotal) * RING_TICKS) : 0
  const nOpen = itemTotal > 0 ? Math.round((openCount / itemTotal) * RING_TICKS) : 0
  const nCompliant = Math.max(0, RING_TICKS - nOverdue - nOpen)
  const tickColors = [
    ...Array(nCompliant).fill(tokens.grn),
    ...Array(nOpen).fill(tokens.amb),
    ...Array(nOverdue).fill(tokens.red),
  ]
  const angleStep = 360 / RING_TICKS
  // RC: "okay, then the My Fleet ring should at least be the color of the
  // most urgent item inside, whatever that is." The proportional dial above
  // already shows the real split, but reading it takes a second; the center
  // number carried no status signal at all (plain t1 regardless of urgency)
  // -- worst-status-wins here gives the ring one instant glanceable color on
  // top of the richer breakdown, same "worst wins" rule the Account row's
  // own mini-ring already uses for the same reason at a size too small for
  // a real proportional dial.
  const worstColor = overdueCount > 0 ? tokens.red : openCount > 0 ? tokens.amb : tokens.grn

  const reduceMotion = useReducedMotion()
  // RC, real device: "the 'how this works' info CTA card isn't responding
  // smoothly to scroll." Root cause: this component stays mounted while
  // navigating to an aircraft's own detail screen (see load()'s own comment
  // on why -- this screen deliberately never unmounts in the background),
  // but its two setInterval loops below kept firing on the JS thread the
  // entire time regardless -- including while genuinely off-screen, and
  // competing with gesture recognition for JS-thread time whenever this
  // screen WAS the one being scrolled. Gating both on real focus (not just
  // "mounted") means the ring visually behaves identically while you're
  // looking at it and does zero background work otherwise.
  const isFocused = useIsFocused()
  const mainPos = useSharedValue(0)
  const breathePulse = useSharedValue(0)
  const ripplePhase = useSharedValue(-1) // -1 = idle, 0..1 = mid-sweep
  const rippleOrigin = useSharedValue(0)

  // Main pill's own slow continuous drift -- same setInterval + withTiming
  // step technique as the retired two-pill version (proven live already):
  // smoother than a single long withTiming, and sidesteps withRepeat's own
  // "restarts toward the same fixed toValue" gotcha for open-ended motion.
  useEffect(() => {
    if (reduceMotion || !isFocused) return
    let pos = 0
    const id = setInterval(() => {
      pos += MAIN_SPEED * (RING_STEP_MS / 1000)
      mainPos.value = withTiming(pos, { duration: RING_STEP_MS, easing: Easing.linear })
    }, RING_STEP_MS)
    return () => clearInterval(id)
  }, [reduceMotion, isFocused, mainPos])

  // Every RIPPLE_PERIOD_MS: inhale FIRST, hold at the peak, then release the
  // ripple exactly as the exhale begins -- RC: "make the main pill breathe
  // BEFORE releasing the ripple, as if it takes a big breath and exhales the
  // large ripple." The ripple used to launch in the SAME tick as the inhale
  // started (simultaneous, not sequenced); now the ripple launch lives
  // inside the inhale's own `finished` callback, so it fires only once the
  // breath has actually finished building.
  useEffect(() => {
    if (reduceMotion || !isFocused) return
    const id = setInterval(() => {
      breathePulse.value = withTiming(1, { duration: BREATHE_MS, easing: Easing.out(Easing.quad) }, (finished) => {
        if (!finished) return
        // Exhale: release the ripple exactly as the breath lets go.
        rippleOrigin.value = mainPos.value
        breathePulse.value = withTiming(0, { duration: BREATHE_MS, easing: Easing.in(Easing.quad) })
        ripplePhase.value = 0
        ripplePhase.value = withTiming(
          RIPPLE_LAPS_TO_CATCH + RIPPLE_TAIL,
          { duration: RIPPLE_DURATION_MS * (RIPPLE_LAPS_TO_CATCH + RIPPLE_TAIL), easing: Easing.linear },
          (finished2) => {
            if (finished2) ripplePhase.value = -1 // back to idle once every tick has finished ringing out
          },
        )
      })
    }, RIPPLE_PERIOD_MS)
    return () => clearInterval(id)
  }, [reduceMotion, isFocused, mainPos, ripplePhase, rippleOrigin, breathePulse])

  return (
    <View style={{ width: RING_SIZE, height: RING_SIZE }}>
      {tickColors.map((color, i) => (
        <RingTick
          key={i} index={i} color={color} angleStep={angleStep}
          mainPos={mainPos} breathePulse={breathePulse} ripplePhase={ripplePhase} rippleOrigin={rippleOrigin}
        />
      ))}
      <View style={[StyleSheet.absoluteFill, styles.ringCenter]}>
        <Text style={[styles.ringCenterNum, { color: worstColor, fontSize: fs(32) }]}>{aircraftTotal}</Text>
        <Text style={[styles.ringCenterUnit, { color: tokens.t4, fontSize: fs(11) }]}>AIRCRAFT</Text>
      </View>
    </View>
  )
}

// A component per tick, not an inline useAnimatedStyle inside FleetRing's
// own .map() -- calling a hook a variable number of times per render inside
// a loop breaks React's rules of hooks even though RING_TICKS happens to be
// constant here; a real component per item is the correct Reanimated
// pattern for "N items all driven by shared state."
function RingTick({
  index, color, angleStep, mainPos, breathePulse, ripplePhase, rippleOrigin,
}: {
  index: number
  color: string
  angleStep: number
  mainPos: ReturnType<typeof useSharedValue<number>>
  breathePulse: ReturnType<typeof useSharedValue<number>>
  ripplePhase: ReturnType<typeof useSharedValue<number>>
  rippleOrigin: ReturnType<typeof useSharedValue<number>>
}) {
  const reduceMotion = useReducedMotion()
  // Computed once per color (not per frame) -- see heatWeightFor's own
  // comment above for why this exists at all.
  const heatWeight = heatWeightFor(color)
  // RC: "the whole ring should give off this slow 'heat wave' feel... add
  // this effect to each pill individually and randomly. they all kind of
  // randomly shimmer, glow, and bulge subtly." A self-scheduling loop
  // entirely local to THIS tick -- no shared timer, no coordination with any
  // other tick or with the main pill/ripple -- so 32 instances of this same
  // effect naturally drift out of sync with each other and never repeat on
  // a predictable rhythm.
  const heatShimmer = useSharedValue(0)
  useEffect(() => {
    if (reduceMotion) return
    let timeoutId: ReturnType<typeof setTimeout>
    const scheduleNext = () => {
      timeoutId = setTimeout(() => {
        const peak = randomBetween(HEAT_SHIMMER_MIN_PEAK, HEAT_SHIMMER_MAX_PEAK)
        const duration = randomBetween(HEAT_SHIMMER_MIN_DURATION_MS, HEAT_SHIMMER_MAX_DURATION_MS)
        heatShimmer.value = withTiming(peak, { duration, easing: Easing.inOut(Easing.sin) }, (finished) => {
          if (finished) heatShimmer.value = withTiming(0, { duration, easing: Easing.inOut(Easing.sin) })
        })
        scheduleNext()
      }, randomBetween(HEAT_SHIMMER_MIN_DELAY_MS, HEAT_SHIMMER_MAX_DELAY_MS))
    }
    scheduleNext()
    return () => clearTimeout(timeoutId)
  }, [reduceMotion, heatShimmer])

  const tickStyle = useAnimatedStyle(() => {
    // RC's real device (Premium, native): "Uncaught Error -- [Worklets]
    // Tried to synchronously call a non-worklet function `_temp`" at this
    // exact line, every time the My Fleet screen opened. The web preview
    // never caught this -- react-native-web's Reanimated shim doesn't
    // enforce the real JS/UI-thread worklet boundary the way native does,
    // so a pattern that's silently fine on web can be a hard crash on a
    // real device. Root cause: `ringDist`/`closeness` were plain arrow
    // functions DEFINED INSIDE this worklet and then called -- normally
    // safe, but Reanimated's Babel plugin has known edge cases where an
    // inner closure gets extracted for cross-thread capture without its own
    // 'worklet' flag attached, producing exactly this "_temp" name. Fixed
    // by removing the intermediate function values entirely: pure inline
    // arithmetic, nothing to call, nothing for the closure-capture step to
    // mishandle. See gotcha_reanimated_shadow_props_frozen_on_web.md for
    // this file's other web-vs-native Reanimated mismatch -- this project's
    // only real device-testing surface for Reanimated code is a real
    // device, not the Browser pane.
    const pMain = ((mainPos.value % RING_TICKS) + RING_TICKS) % RING_TICKS
    const dMain = Math.abs(index - pMain)
    const mainDist = Math.min(dMain, RING_TICKS - dMain)
    // The main pill's own resting presence -- opacity only, so it stays
    // visually distinct from the ripple's scale-bulge below no matter when
    // the two happen to be near each other.
    const mainCloseness = Math.max(0, 1 - mainDist / MAIN_FALLOFF_TICKS)
    const mainDim = mainCloseness * MAIN_MAX_DIM
    // Breathe only visibly scales the tick the main pill is actually
    // sitting on right now -- reusing mainCloseness as the weight means
    // the bump localizes to wherever the pill is without separate tracking.
    const breatheScale = breathePulse.value * BREATHE_AMOUNT * mainCloseness

    // The shockwave: a single smooth exponential decay behind the
    // wavefront's CURRENT absolute position, deliberately NOT oscillating.
    // RC: "you have a dual ripple, a second pill chasing the ripple a few
    // pills behind" -- that second pill was a real second peak the old
    // decay curve used to produce (a periodic cosine wobble re-entering
    // positive territory a few ticks later), not a perception issue. Fixed
    // by dropping the oscillation -- but that first fix still capped
    // ticksBehind's own reference point (phaseAtTick) into a single lap via
    // modulo, which quietly broke the LATER "catch up to the still-moving
    // main pill" fix: ripplePhase can now run past 1.0 into a second,
    // partial lap (see RIPPLE_LAPS_TO_CATCH above), but every tick's
    // ticksBehind was already enormous (and its bulge already zero) by the
    // time phase got that far, since phaseAtTick could only ever describe a
    // tick's FIRST encounter with the wave. The extra catch-up sweep was
    // animating for real, just with no visible bulge anywhere -- exactly
    // RC's report that the ripple "terminates at the spot where the main
    // pill USED to be." Fixed by tracking the wave's absolute (unwrapped)
    // tick position instead of re-deriving a capped phase per tick: mod-ing
    // the DISTANCE from that live position back to each tick naturally
    // finds its most recent passage, whether that's during the first lap or
    // the extra catch-up ticks near the end.
    // RC, after seeing THIS fix live: "you've overshot the ripple, it's now
    // racing PAST the Main pill's current location... get it to catch up
    // to, and disappear into, the main pill." The bug above is fixed, but
    // RIPPLE_TAIL -- originally just a grace period letting an
    // ALREADY-PASSED tick's decay finish playing out -- now had a second,
    // unwanted job now that wavePos can go anywhere: because wavePos keeps
    // growing for the entire RIPPLE_TAIL window too, the wavefront's own
    // PEAK kept physically sweeping forward past the catch-up point instead
    // of stopping there. Fix: freeze the wave's traveled distance at
    // RIPPLE_LAPS_TO_CATCH (exactly the main pill's live position) once
    // phase passes it, so the bulge pattern itself stops moving -- then use
    // the remaining RIPPLE_TAIL phase purely as a fade-to-zero multiplier on
    // that now-stationary bulge, which is what actually reads as "the
    // ripple catches up to and disappears into the main pill" rather than
    // sweeping past it.
    let rippleBulge = 0
    if (ripplePhase.value >= 0) {
      const cappedPhase = Math.min(ripplePhase.value, RIPPLE_LAPS_TO_CATCH)
      const wavePos = rippleOrigin.value + cappedPhase * RING_TICKS
      const ticksBehind = (((wavePos - index) % RING_TICKS) + RING_TICKS) % RING_TICKS
      let bulge = RIPPLE_BULGE_MAX * Math.exp(-ticksBehind / RIPPLE_DECAY_TICKS)
      if (ripplePhase.value > RIPPLE_LAPS_TO_CATCH) {
        const overshoot = ripplePhase.value - RIPPLE_LAPS_TO_CATCH
        bulge *= Math.max(0, 1 - overshoot / RIPPLE_TAIL)
      }
      rippleBulge = bulge
    }

    // Heat: the localized wave-driven glow (main pill / ripple bulge) PLUS
    // this tick's own independent random shimmer, combined -- so the ring
    // reads as hot both where something is actively happening AND as a
    // constant, ambient, unsynchronized simmer everywhere else. Capped
    // short of 1.0: the tick's own status color (compliant/open/overdue) is
    // load-bearing information, not decoration, and can never be fully
    // overridden. backgroundColor is a real animatable property on both
    // native and web, unlike shadowOpacity/shadowRadius (see this file's
    // own gotcha memory on why that approach was dropped).
    const heatIntensity = Math.min(1, mainCloseness + rippleBulge / RIPPLE_BULGE_MAX + heatShimmer.value)
    // heatWeight normalizes the RGB distance actually traveled toward
    // HEAT_COLOR so amber/red/green pills all read as comparably "hot" at
    // the same heatIntensity -- see heatWeightFor's comment above.
    const heatColorIntensity = Math.min(1, heatIntensity * heatWeight)

    return {
      opacity: 1 - mainDim,
      transform: [{ scale: 1 + breatheScale + rippleBulge + heatShimmer.value * HEAT_SHIMMER_SCALE_WEIGHT }],
      backgroundColor: interpolateColor(heatColorIntensity, [0, 1], [color, HEAT_COLOR]),
    }
  })
  return (
    <View style={[StyleSheet.absoluteFill, styles.ringTickWrap, { transform: [{ rotate: `${index * angleStep}deg` }] }]}>
      <Reanimated.View style={[styles.ringTick, tickStyle]} />
    </View>
  )
}

function StatBox({ value, label, color, tokens, fs }: { value: string | number; label: string; color: string; tokens: ThemeTokens; fs: (n: number) => number }) {
  return (
    <View style={[styles.statBox, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}>
      <Text style={[styles.statBoxValue, { color, fontSize: fs(19) }]}>{value}</Text>
      <Text style={[styles.statBoxLabel, { color: tokens.t3, fontSize: fs(9.5) }]}>{label}</Text>
    </View>
  )
}

// RC: "you said [Pro] would be a 'pared down' version of the MyFleet page,
// so i wanted to know what that looks like... since it's just one a/c, we
// take that a/c's status ring/number and just move it up and make it
// bigger, so there's still some visual appeal." Pro's own single aircraft
// already carries real per-aircraft numbers (openAdCount/overdueReminderCount
// from getFleetSummary(), reminderUrgency from the same fetch Premium's
// FleetRing uses) -- no new data needed, just a bigger RowStatusBadge as
// the hero instead of Premium's proportional multi-aircraft FleetRing,
// plus the same StatBox row Premium uses, fed from this one aircraft's own
// numbers instead of fleet sums.
const PRO_HERO_RING_SIZE = 84
// RC: Pro's ring reads plainer than Premium's proportional FleetRing --
// "give it a nice touch, like their a/c is alive and well" -- so it gets a
// slow pulse on the same cadence as the gold Duel-record ring
// (profile/[userId].tsx's GOLD_PULSE_MS), but a different shape: RC asked
// for the main ring to "breathe slightly before releasing the pulse" and
// for the release itself to be two thin, staggered "echo" rings rather than
// one thick halo. The driver stays linear (unlike the gold ring's eased
// withTiming) so each named phase below gets an even, predictable slice of
// the 5s cycle instead of the whole thing being front-loaded by easing.
const PRO_HERO_PULSE_MS = 5000
const PRO_HERO_BREATHE_END = 0.1 // main ring inhale-and-release window
const PRO_HERO_ECHO_WINDOW = 0.4 // each echo ring's own fade/expand duration
const PRO_HERO_ECHO1_START = PRO_HERO_BREATHE_END
const PRO_HERO_ECHO2_START = PRO_HERO_BREATHE_END + 0.08 // trails echo 1 for the ripple feel

function ProHero({
  aircraft, reminderUrgency, nextDueDays, dueSoonCount, tokens, fs, onPressRing,
}: {
  aircraft: FleetAircraftSummary
  reminderUrgency: 'overdue' | 'soon' | 'clear'
  nextDueDays: number | null
  dueSoonCount: number
  tokens: ThemeTokens
  fs: (n: number) => number
  onPressRing: () => void
}) {
  const ringColor = reminderUrgency === 'overdue' ? tokens.red : reminderUrgency === 'soon' ? tokens.amb : tokens.grn
  const numColor = aircraft.openAdCount > 0 ? tokens.amb : tokens.grn
  const label = aircraft.nickname || `${aircraft.make} ${aircraft.model}`

  const reduceMotion = useReducedMotion()
  const pulse = useSharedValue(0)
  useEffect(() => {
    if (reduceMotion) return
    pulse.value = withRepeat(withTiming(1, { duration: PRO_HERO_PULSE_MS, easing: Easing.linear }), -1, false)
  }, [reduceMotion, pulse])

  // The "breathe": a smooth sine bump on the main ring itself, peaking at
  // the midpoint of the breathe window and back to rest exactly as the
  // echoes release -- an inhale-then-let-go rather than a linear grow/shrink.
  const breatheStyle = useAnimatedStyle(() => {
    const p = pulse.value
    const scale = p < PRO_HERO_BREATHE_END
      ? 1 + Math.sin((p / PRO_HERO_BREATHE_END) * Math.PI) * 0.05
      : 1
    return { transform: [{ scale }] }
  })

  // Two thin rings instead of one thick halo, offset in time so the second
  // trails the first outward -- reads as an echo/ripple rather than a single
  // pulse. Each fades out and expands over its own window, invisible before
  // its start and after its window closes.
  //
  // Sentry (fatal, 724 occurrences on a real device): "[Worklets] Tried to
  // synchronously call a non-worklet function `_temp` on the UI thread" --
  // same failure shape as tickStyle's own fix above, but a different root
  // cause: this used to be a single `echoStyle = (start) => useAnimatedStyle(...)`
  // factory function called twice (once per start time) instead of two
  // direct useAnimatedStyle calls. Reanimated's Babel plugin statically
  // finds and tags `useAnimatedStyle(...)` callbacks at their call site --
  // routing the call through a locally-defined wrapper function like that
  // is exactly the kind of indirection its static analysis doesn't reliably
  // see through, so the returned closure could end up untagged and get
  // rejected on the UI thread. Fixed by inlining two separate, direct
  // useAnimatedStyle calls (one per start constant) instead of one
  // factory -- same lesson as tickStyle: no intermediate function values
  // between a component body and useAnimatedStyle's own call site.
  const echo1Style = useAnimatedStyle(() => {
    const p = pulse.value
    const t = Math.min(Math.max((p - PRO_HERO_ECHO1_START) / PRO_HERO_ECHO_WINDOW, 0), 1)
    const active = p >= PRO_HERO_ECHO1_START && p <= PRO_HERO_ECHO1_START + PRO_HERO_ECHO_WINDOW
    return {
      opacity: active ? 0.55 * (1 - t) : 0,
      transform: [{ scale: 1 + t * 0.7 }],
    }
  })
  const echo2Style = useAnimatedStyle(() => {
    const p = pulse.value
    const t = Math.min(Math.max((p - PRO_HERO_ECHO2_START) / PRO_HERO_ECHO_WINDOW, 0), 1)
    const active = p >= PRO_HERO_ECHO2_START && p <= PRO_HERO_ECHO2_START + PRO_HERO_ECHO_WINDOW
    return {
      opacity: active ? 0.55 * (1 - t) : 0,
      transform: [{ scale: 1 + t * 0.7 }],
    }
  })

  return (
    <View style={[styles.proHeroCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
      <Pressable
        style={{ width: PRO_HERO_RING_SIZE, height: PRO_HERO_RING_SIZE }}
        onPress={onPressRing}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="View open ADs"
      >
        <Reanimated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute', top: -5, left: -5, right: -5, bottom: -5,
              borderRadius: (PRO_HERO_RING_SIZE + 10) / 2, borderWidth: 2, borderColor: ringColor,
            },
            echo2Style,
          ]}
        />
        <Reanimated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute', top: -5, left: -5, right: -5, bottom: -5,
              borderRadius: (PRO_HERO_RING_SIZE + 10) / 2, borderWidth: 2, borderColor: ringColor,
            },
            echo1Style,
          ]}
        />
        <Reanimated.View style={[styles.proHeroRing, { borderColor: ringColor }, breatheStyle]}>
          {aircraft.openAdCount > 0 ? (
            <Text style={[styles.proHeroNum, { color: numColor, fontSize: fs(30) }]}>{aircraft.openAdCount}</Text>
          ) : (
            <Icon name="checkmark" size={fs(34)} color={numColor} weight="bold" />
          )}
        </Reanimated.View>
      </Pressable>
      <Text style={[styles.proHeroLabel, { color: tokens.t1, fontSize: fs(16) }]}>{label}</Text>
      {/* Same fix as Premium's fleetCard: the ring above already shows
          openAdCount as its own center number (that's what numColor is
          keying off of), so repeating it here as a third stat box was the
          exact literal-duplicate case RC flagged -- this row is Reminders-
          only now, matching Premium's REMINDERS section content exactly. */}
      <Text style={[styles.legendSectionLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>REMINDERS</Text>
      <View style={styles.statBoxRow}>
        <StatBox value={aircraft.overdueReminderCount} label="OVERDUE" color={tokens.red} tokens={tokens} fs={fs} />
        <StatBox value={dueSoonCount} label="DUE SOON" color={tokens.amb} tokens={tokens} fs={fs} />
        <StatBox value={nextDueDays !== null ? `${nextDueDays}d` : '—'} label="NEXT DUE" color={tokens.grn} tokens={tokens} fs={fs} />
      </View>
    </View>
  )
}

// RC: "since the top part already tells us what the colors mean, we don't
// need it to say 'open' or 'overdue' in the a/c box, it can just be a big
// colored number with the colored circle/ring around it. cleaner." The
// ring+legend above already teaches green/amber/red -- repeating the word
// on every row was the redundant part, not the color itself. Compliant has
// no natural count to show (an aircraft doesn't have "0 compliant items"
// the way it has "2 open ADs"), so that one gets a checkmark instead of a
// number rather than displaying a bare, slightly odd-looking "0".
// RC, live, on a screenshot showing a green check on a row that actually
// had an amber (due-soon) reminder hiding inside: "this ring color does
// NOT seem to associate with anything happening w/ the a/c... these things
// need to be in sync and properly associative." The old version cascaded
// ONE number through two different meanings (overdue-reminder-count, THEN
// open-AD-count, whichever was nonzero) and coincidentally left the ring
// green whenever neither was nonzero -- which is exactly how a due-soon
// (not yet overdue) reminder went invisible. Confirmed split instead: the
// ring is always reminder urgency (the thing with real due dates that can
// creep from fine to urgent), the number is always open-AD count (a flatter
// yes/no-attention signal) -- two independent, single-purpose glyphs that
// can never visually contradict each other. See my-aircraft-intro's own
// InfoPopup body for the user-facing explanation of this split.
function RowStatusBadge({
  openAdCount, reminderUrgency, tokens, fs,
}: {
  openAdCount: number
  reminderUrgency: 'overdue' | 'soon' | 'clear'
  tokens: ThemeTokens
  fs: (n: number) => number
}) {
  const ringColor = reminderUrgency === 'overdue' ? tokens.red : reminderUrgency === 'soon' ? tokens.amb : tokens.grn
  const numColor = openAdCount > 0 ? tokens.amb : tokens.grn
  return (
    <View style={[styles.rowStatusRing, { borderColor: ringColor }]}>
      {openAdCount > 0 ? (
        <Text style={[styles.rowStatusNum, { color: numColor, fontSize: fs(15) }]}>{openAdCount}</Text>
      ) : (
        // RC, light mode: a plain-weight green checkmark on a bright
        // background reads weak -- bigger + bold (weight only takes effect
        // on native SF Symbols; Ionicons' web fallback has no bold axis, so
        // size is what actually helps there).
        <Icon name="checkmark" size={fs(17)} color={numColor} weight="bold" />
      )}
    </View>
  )
}

// RC: "I want the actual visual 'ring' and the actual big, bold, colored
// number... the whole point is that the user sees the actual 'icon'
// representation of these inside this info box, in the same way they're
// presented on screen" -- rejected the prior text-bullet legend entirely.
// Miniature of RowStatusBadge's own ring, not a new shape: `ringOnly` swatches
// (Reminders legend) isolate border color with nothing inside since ring
// color is the whole point there; number/checkmark swatches (AD-status
// legend) use a neutral border so the colored content itself reads as the
// point instead. "Line them up in a row w/ a small tick mark between them."
// Named Ring*/Popup* specifically (not the more obvious Legend*) -- this
// file already has its own unrelated LegendRow/legendRow/legendLabel for
// the FleetRing's compliant/open/overdue dot legend.
function PopupRingSwatch({
  color, ringOnly, checkmark, label, tokens, fs,
}: {
  color: string
  ringOnly?: boolean
  checkmark?: boolean
  label: string
  tokens: ThemeTokens
  fs: (n: number) => number
}) {
  return (
    <View style={styles.ringLegendItem}>
      <View style={[styles.ringLegendCircle, { borderColor: ringOnly ? color : tokens.bdr2 }]}>
        {!ringOnly && (
          checkmark ? (
            <Icon name="checkmark" size={fs(13)} color={color} weight="bold" />
          ) : (
            <Text style={[styles.ringLegendNum, { color, fontSize: fs(12.5) }]}>4</Text>
          )
        )}
      </View>
      <Text style={[styles.ringLegendItemLabel, { color: tokens.t3, fontSize: fs(10) }]}>{label}</Text>
    </View>
  )
}

function PopupRingSwatchRow({ items, tokens }: { items: React.ReactNode[]; tokens: ThemeTokens }) {
  return (
    <View style={styles.ringLegendRow}>
      {items.map((child, i) => (
        <View key={i} style={styles.ringLegendRowItem}>
          {i > 0 && <View style={[styles.ringLegendTick, { backgroundColor: tokens.t4 }]} />}
          {child}
        </View>
      ))}
    </View>
  )
}

// RC, real device: "something is 'sluggish' when entering info into all
// these boxes. it's like it takes two taps to get it to respond." This
// form's fields used to be state on MyAircraftBody itself -- every
// keystroke re-rendered that entire screen (FleetRing's Reanimated ticks,
// the full aircraft list, stat boxes, everything), none of it memoized.
// A standalone component with its own local state means typing here only
// re-renders THIS small subtree; MyAircraftBody only hears about it via
// onAdded/onCancel, and only once, on submit or cancel -- not per
// keystroke. Owns the full add flow (validation, cap check, the insert
// itself) that used to live in MyAircraftBody's handleAdd; only the
// post-add side effects that genuinely belong to the parent (closing this
// form, refreshing the list, the AD backfill) stayed there, reached via
// onAdded.
function AddAircraftForm({
  aircraftCount, onAdded, onCancel, tokens, fs,
}: {
  aircraftCount: number
  onAdded: (insertedId: string) => void
  onCancel: () => void
  tokens: ThemeTokens
  fs: (n: number) => number
}) {
  const ifs = useInputFS()
  const { session, isPremium, hasProAccess } = useAuth()
  const confirm = useConfirm()
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [nickname, setNickname] = useState('')
  const [typeDesignator, setTypeDesignator] = useState('')
  const [year, setYear] = useState<number | null>(null)
  const [yearPickerOpen, setYearPickerOpen] = useState(false)
  const typeDesignatorEdited = useRef(false)
  const [saving, setSaving] = useState(false)

  const handleModelChange = (text: string) => {
    setModel(text)
    if (!typeDesignatorEdited.current) setTypeDesignator(suggestTypeDesignator(text) ?? '')
  }

  const handleTypeDesignatorChange = (text: string) => {
    typeDesignatorEdited.current = true
    setTypeDesignator(text)
  }

  // RC: "the add a/c box also needs a cancel option." Collapsing the
  // trigger alone (onCancel) would leave whatever the user had already
  // typed sitting in state, silently reappearing pre-filled the next time
  // they tapped "+ Add Aircraft" -- same reset the real Add Aircraft
  // success path below does, just without saving.
  const handleCancelAdd = () => {
    setMake('')
    setModel('')
    setNickname('')
    setTypeDesignator('')
    setYear(null)
    typeDesignatorEdited.current = false
    onCancel()
  }

  const handleAdd = async () => {
    if (!session) {
      router.push('/auth')
      return
    }
    // hasProAccess (isPro || isPremium), not bare isPro -- found during the
    // 2026-08-14 gating re-audit: a real Premium subscriber (isPro: false,
    // isPremium: true, the shape an admin/comp-granted account can have)
    // hit this exact bug, matching saved.tsx/notes.tsx/study.tsx's own
    // earlier-caught instances of the same class.
    if (!hasProAccess) {
      router.push('/paywall')
      return
    }
    // Pro is capped at 1 saved aircraft (most owners have exactly one);
    // Premium is unlimited -- see flyregs_decisions.md's pricing pivot.
    if (!isPremium && aircraftCount >= PRO_AIRCRAFT_CAP) {
      confirm({
        title: 'Aircraft limit reached',
        message: `Pro includes ${PRO_AIRCRAFT_CAP} saved aircraft. Upgrade to Premium for unlimited.`,
        confirmLabel: 'Upgrade to Premium',
        onConfirm: () => router.push('/paywall?tier=premium'),
      })
      return
    }
    const trimmedMake = make.trim()
    // Uppercased at save, not while typing -- see AircraftFormFields.tsx's
    // TypeDesignatorField (BB-074, real device beta report).
    const trimmedType = typeDesignator.trim().toUpperCase()
    // Some aircraft have no separate marketing name (a Pilatus PC-12 isn't
    // "known by" anything other than its own type designator) -- RC, live:
    // "i don't think that a/c has a 'name', i think it's just known by
    // that model/type designator." Rather than force a fake distinct Model
    // value in that case, fall back to the type designator itself.
    const trimmedModel = model.trim() || trimmedType
    if (!trimmedMake || !trimmedModel) {
      confirm({ title: 'Make and model required', message: 'Enter both the aircraft make and model.', cancelLabel: null })
      return
    }
    // Type designator is what AD applicability is actually matched against
    // (see the type-hint copy below and adNotifications.ts) -- a saved
    // aircraft with no designator can silently never match a real
    // applicable AD, so this is no longer a skippable field. RC, live:
    // "the type designator probably shouldn't be 'optional' if we expect
    // to find the actual a/c since that is the field FR uses to hunt for
    // it."
    if (!trimmedType) {
      confirm({ title: 'Type designator required', message: 'Enter the FAA type designator (e.g. PA-28-181, 172S) so we can match Airworthiness Directives correctly.', cancelLabel: null })
      return
    }
    setSaving(true)
    const { data: inserted, error } = await supabase
      .from('user_aircraft')
      .insert({
        user_id: session.user.id, make: trimmedMake, model: trimmedModel,
        nickname: nickname.trim() || null, type_designator: trimmedType,
        year,
      })
      .select('id')
      .single()
    setSaving(false)
    if (error) {
      confirm({ title: 'Could not add aircraft', message: error.message, cancelLabel: null })
      return
    }
    setMake('')
    setModel('')
    setNickname('')
    setTypeDesignator('')
    setYear(null)
    typeDesignatorEdited.current = false
    onAdded(inserted.id)
  }

  return (
    <>
      <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), marginTop: 20 }]}>
        ADD AIRCRAFT{!isPremium ? ` (${aircraftCount}/${PRO_AIRCRAFT_CAP} — Premium for unlimited)` : ''}
      </Text>
      <View style={[styles.formCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
        <MakeField value={make} onChangeText={setMake} tokens={tokens} fs={fs} />
        <ModelField
          value={model}
          onChangeText={handleModelChange}
          onSelectDesignator={(d) => { if (!typeDesignatorEdited.current) setTypeDesignator(d) }}
          tokens={tokens}
          fs={fs}
        />
        <View style={styles.typeDesignatorRow}>
          <View style={{ flex: 1 }}>
            <TypeDesignatorField
              value={typeDesignator}
              onChangeText={handleTypeDesignatorChange}
              onSelectManufacturer={(mfr) => { if (!make.trim()) setMake(mfr) }}
              onSelectModel={(m) => { if (!model.trim()) setModel(m) }}
              manufacturer={make}
              tokens={tokens}
              fs={fs}
            />
          </View>
          {/* RC: "let's turn this text into just an info icon. we
              can show once as CTA if nec, but after that, icon
              only" -- was an always-visible paragraph explaining
              Model vs. Type Designator; same tap-to-reveal pattern
              as "How this works" above, just no label text at all
              this time, matching "icon only" literally. */}
          <InfoPopup
            id="my-aircraft-model-type-hint"
            title="Model vs. Type Designator"
            body="Model is the marketing name (Skyhawk, Warrior) if it has one — Type designator is the FAA's technical code (172S, PA-28-181) that Airworthiness Directives are actually filed under. We auto-suggest a type from common model names; some aircraft (e.g. Pilatus PC-12) aren't known by any name besides their type — just enter it in both fields."
            forceOnce
            iconSize={fs(17)}
          />
        </View>
        <YearField value={year} onPress={() => setYearPickerOpen(true)} tokens={tokens} fs={fs} />
        <TextInput
          value={nickname}
          onChangeText={setNickname}
          placeholder="Nickname (optional, e.g. N12345)"
          placeholderTextColor={tokens.t3}
          style={[styles.input, { color: tokens.t1, fontSize: ifs(14.5), borderColor: tokens.bdr }]}
        />
        <Pressable
          style={[styles.addButton, { backgroundColor: tokens.blu }]}
          onPress={handleAdd}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={[styles.addButtonText, { fontSize: fs(14.5) }]}>Add Aircraft</Text>
          )}
        </Pressable>
        <Pressable onPress={handleCancelAdd} disabled={saving} style={styles.cancelAddBtn} hitSlop={8}>
          <Text style={[styles.capDismiss, { color: tokens.t3, fontSize: fs(13) }]}>Cancel</Text>
        </Pressable>
      </View>
      <YearPickerModal
        visible={yearPickerOpen}
        initialYear={year}
        onClose={() => setYearPickerOpen(false)}
        onSelect={setYear}
        tokens={tokens}
        fs={fs}
      />
    </>
  )
}

// RC, iPad: "let's figure out how to build the 3 pane slide out" (Account
// beside the drawer already shipped; My Aircraft/My Fleet as a genuine 3rd
// pane was deliberately deferred pending this). Splitting the body out from
// the route wrapper -- same pattern ACBody.tsx already established -- lets
// account.tsx embed the real, full-featured screen directly as a 3rd pane
// instead of guessing at react-navigation's stack-layering behavior or
// duplicating any of this screen's logic. `embedded`/`onClose` default to
// the exact values that make this behave byte-for-byte like the original
// unexported component below -- the real route (phone and any non-rail
// iPad case) never passes either, so nothing here changes for it.
export function MyAircraftBody({ embedded = false, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const { session, isPro, isPremium, hasProAccess } = useAuth()
  const confirm = useConfirm()
  const [aircraft, setAircraft] = useState<FleetAircraftSummary[]>([])
  const [loading, setLoading] = useState(true)
  // RC: "make sure the Icon and h/t time also appear here" -- the same
  // self-reported hobbs/tach value shown on the aircraft detail screen,
  // now also visible (and editable inline, no navigation) on the list row.
  const [hobbsEditing, setHobbsEditing] = useState<FleetAircraftSummary | null>(null)
  // Soonest upcoming (not overdue) reminder due date across the whole
  // fleet, for the ring card's "NEXT DUE" stat box. get_fleet_summary()
  // only returns an overdue COUNT, not individual due dates, so this is a
  // second, small parallel fetch rather than a new RPC/migration -- fleet
  // sizes are small, N lightweight per-aircraft queries is fine and reuses
  // the exact same getAircraftReminders already used elsewhere on this
  // screen instead of trusting a new cross-aircraft RLS assumption.
  const [nextDueDays, setNextDueDays] = useState<number | null>(null)
  // Per-aircraft worst reminder status, keyed by aircraftId -- computed
  // from the same reminders fetch as nextDueDays above (see RowStatusBadge
  // for why this needs to be a real 3-state value, not just the RPC's
  // overdueReminderCount, to catch "due soon" too).
  const [reminderUrgency, setReminderUrgency] = useState<Record<string, 'overdue' | 'soon' | 'clear'>>({})
  // Fleet-wide count of individual reminders due within 30 days (not yet
  // overdue) -- RC, real device: once the stat-box row became Reminders-
  // only, asked directly what belongs in the middle box between OVERDUE and
  // NEXT DUE. This reuses the exact same 30-day "soon" threshold
  // reminderUrgency already applies per-aircraft, just summed across every
  // individual reminder instead of collapsed to one worst-status flag --
  // no new fetch, same data this screen already loads.
  const [dueSoonCount, setDueSoonCount] = useState<number>(0)
  // RC: "let's keep this whole 'add a/c' area collapsed. just a small
  // 'Add Aircraft +' which can expand when needed... this screen will have
  // status wheel, a/c dropdowns, etc. It's busy enough w/o this Add feature
  // always open." Collapses back to the compact trigger after a successful
  // add too (handleAdd), not just on first load.
  const [addFormOpen, setAddFormOpen] = useState(false)
  // Accordion, not multi-expand -- RC: "i like the inline expand for the
  // a/c's in Fleet... tap to expand is the top part and we put a small
  // button... at the bottom which takes you into that full a/c page."
  // One aircraft expanded at a time keeps a long fleet list scannable;
  // details are lazy-fetched on first expand and cached per aircraft so
  // re-collapsing/re-expanding the same row doesn't re-fetch.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedDetails, setExpandedDetails] = useState<Record<string, { ads: AircraftAdNotification[]; reminders: AircraftReminder[] } | 'loading'>>({})
  // RC: "for Pro, we can probably leave this Aircraft box open by default,
  // since there's only one." Keyed on the actual reason (exactly one
  // aircraft, so there's nothing to scan or choose between) rather than on
  // tier -- a Premium user who happens to own one aircraft is in the
  // identical situation, and gating it to Pro would make the same screen
  // behave two different ways for the same content. Ref-guarded so it only
  // fires on the first load of this mounted screen: collapsing it stays
  // collapsed instead of springing back open on the next focus refetch.
  const autoExpandedRef = useRef(false)

  // RC, on the status pill: "whatever data these are representing, let's
  // show that in the dropdown when it's tapped on." An earlier pass
  // dropped the AD list here entirely, reasoning the row's own "N open
  // ADs" chip already said the count -- true, but it meant tapping to
  // expand answered "how many" and never "which ones," the one thing the
  // Overdue pill's Reminders section already did answer. Back, but lighter
  // than before: just AD number chips, not the full subject-heading rows.
  const toggleExpand = (aircraftId: string) => {
    if (expandedId === aircraftId) { setExpandedId(null); return }
    setExpandedId(aircraftId)
    if (!expandedDetails[aircraftId]) {
      setExpandedDetails((prev) => ({ ...prev, [aircraftId]: 'loading' }))
      Promise.all([getAircraftAdNotifications(aircraftId), getAircraftReminders(aircraftId)])
        .then(([ads, reminders]) => setExpandedDetails((prev) => ({ ...prev, [aircraftId]: { ads, reminders } })))
        .catch(() => setExpandedDetails((prev) => { const next = { ...prev }; delete next[aircraftId]; return next }))
    }
  }

  // RC found no way to mark an AD complied without drilling all the way
  // into the aircraft's own detail screen -- the chip here just navigated
  // to the generic (non-aircraft-scoped) AD page, a dead end for this
  // action. Mirrors [id].tsx's own confirm wording/disclaimer exactly (same
  // feature, same register, per the corpus-wide feature-consistency rule)
  // but updates state IN PLACE instead of navigating away: this list stays
  // mounted underneath the aircraft detail screen, so navigating there and
  // back already refreshes via useFocusEffect, but a same-screen action has
  // no focus event to hook -- the summary ring and row badge would go stale
  // until the next full reload without this local patch.
  // Mirrors getAircraftAdNotifications' own .order() chain exactly (complied_at
  // ascending nulls-first, then read_at ascending nulls-first, then id
  // descending) -- so re-sorting THIS array locally after an optimistic
  // toggle produces the identical order a real refetch would, instead of
  // drifting from it. RC: after marking an AD complied, its chip "took a
  // long time to organize and move to the end of the list." Root cause: the
  // optimistic update below toggled compliedAt on the matching item but
  // never re-sorted the array, so the chip stayed at its OLD position among
  // the still-open ones -- checkmarked, but not actually relocated -- until
  // whatever eventually triggered a real refetch, which this same-screen
  // action has no natural event for.
  const nullsFirst = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1)
  const compareAdNotifications = (a: AircraftAdNotification, b: AircraftAdNotification) =>
    nullsFirst(a.compliedAt, b.compliedAt) || nullsFirst(a.readAt, b.readAt) || b.id - a.id

  const handleToggleCompliedFromList = (aircraftId: string, n: AircraftAdNotification) => {
    const wasComplied = !!n.compliedAt
    confirm({
      title: wasComplied ? `Un-mark AD ${n.adNumber}?` : `Mark AD ${n.adNumber} complied?`,
      message: wasComplied
        ? 'This moves it back to open.'
        : "This records that you've completed what this AD requires. FlyRegs doesn't independently verify compliance -- always keep your own maintenance records as the official source.",
      confirmLabel: wasComplied ? 'Un-mark' : 'Mark Complied',
      onConfirm: async () => {
        if (wasComplied) await unmarkAdComplied(n.id)
        else await markAdComplied(n.id, null)
        const nowComplied = wasComplied ? null : new Date().toISOString()
        setExpandedDetails((prev) => {
          const cur = prev[aircraftId]
          if (!cur || cur === 'loading') return prev
          const nextAds = cur.ads
            .map((x) => (x.id === n.id ? { ...x, compliedAt: nowComplied } : x))
            .sort(compareAdNotifications)
          return { ...prev, [aircraftId]: { ...cur, ads: nextAds } }
        })
        // openAdCount/compliantAdCount move in lockstep, opposite directions
        // -- an AD is always in exactly one of the two buckets (see
        // aircraftSharing.ts's own compliantAdCount comment), so un-marking
        // one is a real transfer, not just a decrement on one side.
        setAircraft((prev) =>
          prev.map((a) => (a.aircraftId === aircraftId ? {
            ...a,
            openAdCount: Math.max(0, a.openAdCount + (wasComplied ? 1 : -1)),
            compliantAdCount: Math.max(0, a.compliantAdCount + (wasComplied ? -1 : 1)),
          } : a))
        )
      },
    })
  }

  // RC: after building handleToggleCompliedFromList, still couldn't find any
  // way to mark an AD complied on either My Fleet or My Aircraft -- it was
  // there, but only inside the row's EXPAND panel, a step most people never
  // take just to see status. This makes the collapsed row's own status badge
  // (and Pro's single-aircraft hero ring, which shows the identical number)
  // directly tappable: no expand required, one tap from the list screen
  // itself straight to a picker of the open ADs, then straight into the same
  // confirm as before. Falls back to a fresh fetch if the row was never
  // expanded (so expandedDetails has nothing cached for it yet).
  const handleQuickComplied = async (a: FleetAircraftSummary) => {
    if (!(a.role === 'owner' || a.role === 'editor')) return
    const label = a.nickname || `${a.make} ${a.model}`
    const cached = expandedDetails[a.aircraftId]
    let list: AircraftAdNotification[]
    if (cached && cached !== 'loading') {
      list = cached.ads
    } else {
      try {
        list = await getAircraftAdNotifications(a.aircraftId)
      } catch (e: any) {
        confirm({ title: 'Could not load ADs', message: e?.message ?? 'Unknown error', cancelLabel: null })
        return
      }
    }
    const open = list.filter((n) => !n.compliedAt)
    if (open.length === 0) {
      confirm({ title: 'All compliant', message: `No open ADs for ${label}.`, cancelLabel: null })
      return
    }
    confirm({
      title: `Open ADs — ${label}`,
      choices: open.map((n) => ({ label: `AD ${n.adNumber}`, onPress: () => handleToggleCompliedFromList(a.aircraftId, n) })),
    })
  }

  const load = useCallback(() => {
    if (!session) {
      setLoading(false)
      return
    }
    // get_fleet_summary() returns owned AND shared aircraft in one call,
    // each with its own role and real (not invented) alert counts -- see
    // aircraftSharing.ts's own comment on why this replaced a plain
    // user_aircraft select.
    const aircraftCap = aircraftCapForTier(isPro, isPremium)
    getFleetSummary()
      .then((all) => {
        // Second, independent application of the same cap the server just
        // applied. Not redundant: the server deliberately fails OPEN when
        // user_entitlements has no row yet (a sync hiccup must never make a
        // paying customer's fleet look deleted), and this is the check that
        // covers exactly that window, since RevenueCat's own answer is
        // already in hand here. Everything downstream -- the hero, the
        // stat-box totals, the reminder fetch, the cap CTA -- reads from
        // this capped list, so no path re-widens it.
        const rows = all.slice(0, aircraftCap)
        setAircraft(rows)
        Promise.all(rows.map((a) => getAircraftReminders(a.aircraftId).catch(() => [] as AircraftReminder[])))
          .then((lists) => {
            let soonest: number | null = null
            let soonCount = 0
            const urgency: Record<string, 'overdue' | 'soon' | 'clear'> = {}
            lists.forEach((list, i) => {
              let worst: 'overdue' | 'soon' | 'clear' = 'clear'
              for (const r of list) {
                const days = daysUntil(r.dueDate)
                if (days >= 0 && (soonest === null || days < soonest)) soonest = days
                if (days >= 0 && days <= 30) soonCount++
                if (days < 0) worst = 'overdue'
                else if (days <= 30 && worst !== 'overdue') worst = 'soon'
              }
              urgency[rows[i].aircraftId] = worst
            })
            setNextDueDays(soonest)
            setReminderUrgency(urgency)
            setDueSoonCount(soonCount)
          })
          .catch(() => { setNextDueDays(null); setReminderUrgency({}); setDueSoonCount(0) })
      })
      .catch((e) => console.error('Failed to load fleet summary:', e?.message ?? e))
      .finally(() => setLoading(false))
  }, [session, isPro, isPremium])

  // useFocusEffect, not a plain mount-only useEffect: this screen stays
  // mounted in the background while you're on an aircraft's detail screen,
  // so a bare useEffect would only ever fetch once and go stale the moment
  // you mark an AD complied or edit a reminder and come back -- the ring,
  // legend, stat boxes, and per-row badges would all keep showing pre-edit
  // numbers until a full app relaunch. RC: "make sure that status ring is
  // smart - and adjusts live to the number (%) of Compliant, Open, and
  // Overdue items across the fleet."
  useFocusEffect(useCallback(() => { load() }, [load]))

  // See autoExpandedRef's declaration for why this is keyed on "exactly one
  // aircraft" rather than on tier. toggleExpand is deliberately not in the
  // dep array (it's recreated every render); the ref guard is what makes
  // this run exactly once, not the deps.
  useEffect(() => {
    if (autoExpandedRef.current || aircraft.length !== 1) return
    autoExpandedRef.current = true
    toggleExpand(aircraft[0].aircraftId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aircraft])

  // RC, real device: "something is 'sluggish' when entering info into all
  // these boxes. it's like it takes two taps to get it to respond." The
  // Add Aircraft form's fields (make/model/typeDesignator/nickname/year)
  // used to be state on THIS component -- every keystroke re-rendered the
  // entire screen (ring, legend, stat boxes, the full aircraft list) along
  // with it, since none of that is memoized. On a real device that's
  // enough dropped frames per keystroke to feel like the first tap didn't
  // register. Moved the whole form (state, validation, insert) into its
  // own AddAircraftForm component below -- typing in it no longer touches
  // this component's state at all, only the two callbacks below fire, and
  // only on submit/cancel. This function is what AddAircraftForm calls
  // after a successful insert; everything below is the same post-add
  // sequence handleAdd used to run inline (close the form, refresh, then
  // the full-AD-corpus backfill + its own follow-up refresh).
  const handleAircraftAdded = (insertedId: string) => {
    setAddFormOpen(false)
    load()
    // Backfill against the FULL AD corpus, not just future ones -- a
    // freshly-added aircraft otherwise starts with an empty Applicable ADs
    // list even if real ADs already exist for it. See adNotifications.ts's
    // own comment. Fires after the list already reloaded above so this
    // never blocks the aircraft itself from saving.
    backfillAircraftAds(insertedId)
      .then((count) => {
        if (count > 0) {
          confirm({
            title: 'Aircraft added',
            message: `Found ${count} existing Airworthiness Directive${count === 1 ? '' : 's'} that may apply — see its Applicable ADs list.`,
            cancelLabel: null,
          })
          // RC, real device: "when i input this info initially it didn't
          // update, it wasn't until this morning that i saw that counts
          // had populated." Root cause: this whole backfill deliberately
          // fires AFTER the load() above (so it never blocks the aircraft
          // itself from saving) -- but nothing ever called load() again
          // once it actually finished. The confirm() above told the user
          // real ADs were found; the ring/legend/stat-boxes/row badge
          // stayed frozen on their PRE-backfill (zero) snapshot regardless,
          // correct only the next time something else happened to
          // refocus this screen -- which could genuinely be way later,
          // since a same-screen background completion has no natural
          // refocus event of its own.
          load()
        }
      })
      .catch((e) => {
        // Best-effort, but not silent -- the aircraft itself saved fine,
        // this only affects whether its AD list is pre-populated yet.
        console.error('AD backfill failed for new aircraft:', e?.message ?? e)
      })
  }

  // RC: swipe-to-delete "with two step CTA popup verification explaining
  // what will be deleted" -- this previously had NO confirm at all before
  // deleting a whole aircraft record (the riskiest delete on this screen),
  // which matters even more now that a swipe, not just a deliberate trash
  // tap, can trigger it.
  const handleRemove = (a: FleetAircraftSummary) => {
    const label = a.nickname || `${a.make} ${a.model}`
    // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
    // Native Web, so this confirm (and the delete behind it) was untestable
    // in the Browser pane. See components/ConfirmDialog.tsx.
    confirm({
      title: `Delete ${label}?`,
      message: 'This permanently removes the aircraft and its equipment, reminders, and AD history. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
      // Two-step with the button MOVING between steps (RC's design) rather
      // than typed confirmation. RC re-scoped the stakes correctly: losing
      // an aircraft costs a few minutes -- ADs repopulate themselves from
      // make/model, and it's ~5 reminders to re-enter -- so demanding typed
      // input for it is friction out of proportion to the harm. Moving the
      // button still defeats every realistic accident, because the second
      // tap has to land somewhere the first one wasn't.
      finalTitle: `Delete ${label} — confirm`,
      onConfirm: async () => {
        const { error } = await supabase.from('user_aircraft').delete().eq('id', a.aircraftId)
        // Previously unchecked -- a failed delete silently left the row in
        // the DB while the list optimistically dropped it, so the aircraft
        // reappeared on the next refresh with no explanation.
        if (error) throw error
        setAircraft((prev) => prev.filter((x) => x.aircraftId !== a.aircraftId))
      },
    })
  }

  // Premium sees "My Fleet" (unlimited, sharing-capable) -- Free/Plus/Pro
  // still see "My Aircraft" (capped at 1, no sharing) -- same screen, same
  // Account entry point, RC-confirmed: "so for Prem, does My Aircraft just
  // become My Fleet? in the same space in Account?"
  const screenTitle = isPremium ? 'My Fleet' : 'My Aircraft'
  // Same condition handleAdd already enforced at submit time -- hoisted so
  // the Add trigger can enforce it at the point of entry instead (see the
  // capCard below). `>=`, not `===`: an account downgraded from Premium can
  // legitimately be sitting on more saved aircraft than the Pro cap allows.
  const aircraftCap = aircraftCapForTier(isPro, isPremium)
  const atProCap = aircraft.length >= aircraftCap
  const totalOpenAds = aircraft.reduce((sum, a) => sum + a.openAdCount, 0)
  const totalOverdue = aircraft.reduce((sum, a) => sum + a.overdueReminderCount, 0)
  // Ring/legend counts USED TO be AIRCRAFT counted in exactly one bucket
  // each (its worst status) -- e.g. an aircraft with both an overdue
  // reminder and an open AD counted once, under Overdue, not both -- so the
  // three numbers always summed to the fleet total. RC, real device: "the
  // count up top isn't matching how many open/compliant ADs there are...
  // 12 open and 3 complied ADs, but the top numbers don't match at all."
  // Confirmed real -- with RC's 1-aircraft fleet, that scheme always shows
  // 0 or 1 for "Compliant"/"Open AD" no matter how many of that aircraft's
  // real ADs are actually complied, since it was counting AIRCRAFT, not
  // ADs. Now real item-level sums across the fleet, matching the stat
  // boxes below and the Applicable ADs list's own checkmarks exactly.
  const totalCompliantAds = aircraft.reduce((sum, a) => sum + a.compliantAdCount, 0)
  // RC: matches the reference image's own "Sorted by urgency" list order --
  // overdue first, then open, then compliant; alphabetical by make/model as
  // the tiebreak within each bucket (get_fleet_summary()'s own default
  // order, preserved via a stable sort rather than re-sorted).
  const urgency = (a: FleetAircraftSummary) => (a.overdueReminderCount > 0 ? 0 : a.openAdCount > 0 ? 1 : 2)
  const sortedAircraft = [...aircraft].sort((a, b) => urgency(a) - urgency(b))

  // Destination-level guard, added after a live audit found this screen is
  // directly reachable (ad/index.tsx's "My Aircraft" hub card, and any
  // direct URL/deep link) without going through account.tsx's own
  // hasProAccess check first. account.tsx's Row onPress already redirects
  // straight to /paywall before ever pushing this route ("Free and Plus
  // don't have a My Aircraft bar... Free/Plus go straight to the paywall
  // instead of into a screen that would only block them once they try to
  // add an aircraft" -- RC's own stated design), but that only protects
  // THAT one entry point. No data was ever exposed (aircraftCap already
  // caps the list to 0 for non-Pro, and handleAdd already blocked the
  // write), but the screen itself rendered fully -- header, "How this
  // works", empty state, Add Aircraft button -- with zero indication it's
  // paid, exactly the confusing-dead-end anti-pattern already fixed
  // elsewhere in this app (see gotcha_duel_accept_missing_client_paywall.md).
  // Mirrors study.tsx's own lock screen, including embedded (iPad rail)
  // mode -- and, like study.tsx, this was ALSO found gated on bare `isPro`
  // (2026-08-14 gating re-audit) which would wrongly lock out a real
  // Premium subscriber shaped isPro:false/isPremium:true. Fixed to
  // hasProAccess to match.
  if (!hasProAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="My Aircraft" onBack={embedded ? (onClose ?? (() => {})) : () => router.back()} />
        <View style={styles.lockCenter}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>My Aircraft is a Pro feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Save your aircraft to get AD alerts, maintenance reminders, and part lookups matched to what you actually fly.
          </Text>
          <Pressable style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall')}>
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Unlock Pro</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    // KeyboardAvoidingView, not a plain View -- without it, focusing any of
    // the Add Aircraft form's TextInputs (Make/Model/Type/Nickname) let the
    // iOS keyboard overlay the whole entry area with nothing to push it out
    // of the way, exactly this screen's own ScrollView notwithstanding
    // (scroll position alone doesn't account for the keyboard's height).
    // Same fix, same pattern feedback.tsx already uses.
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: tokens.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <OverlayHeader title={screenTitle} onBack={embedded ? (onClose ?? (() => {})) : () => router.back()} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer disabled={embedded}>
        {/* keyboardShouldPersistTaps="handled" -- without it (RN's default
            is "never"), the first tap on any Type/Make/Model suggestion
            row below just dismissed the keyboard instead of firing the
            row's onPress, since the keyboard is always up while the user
            is mid-typeahead. BB-092, real device beta report: "none of
            them are selectable... this COMPLETELY defeats the point." */}
        {/* automaticallyAdjustKeyboardInsets -- RC: "the search boxes need
            to be moved up the screen a bit so the box itself isn't hidden
            by the k/b when it's present." The root KeyboardAvoidingView
            above only shrinks the available height by the keyboard's size;
            it doesn't know WHERE on screen the focused field is, so a field
            that's already low (e.g. this form opened after an existing
            fleet list, or Nickname/Year near the form's bottom) can still
            end up right under or behind the keyboard. This is iOS's own
            native auto-scroll-focused-input-into-view behavior (same
            mechanism UIScrollView keyboard avoidance uses) -- no manual
            measure/scrollTo logic needed, and it composes with the existing
            KeyboardAvoidingView rather than replacing it (that one still
            owns "keyboard blocks the whole entry area," fixed separately,
            see gotcha_addaircraft_keyboard_covers_form). iOS only, matching
            every other keyboard-behavior prop already on this ScrollView. */}
        <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
          <View style={styles.introRow}>
            <Text style={[styles.intro, { color: tokens.t3, fontSize: fs(13) }]}>How this works</Text>
            <InfoPopup
              id="my-aircraft-intro"
              title={screenTitle}
              body={[
                'Save the aircraft you fly or maintain to get alerted when a new or updated Airworthiness Directive applies to them, instead of scanning the full AD list yourself.',
                'Premium can share an aircraft with other Premium accounts as a viewer or editor.',
                'Sorted by urgency — overdue first, then open items, then compliant.',
                'This tracking is not a substitute for your mechanic, A&P, or other professional airworthiness sources — always verify compliance through official channels.',
              ]}
              footer={
                <View style={styles.ringLegendSection}>
                  {/* RC, real device: "we'll need to update the info icon to
                      explain the diff bet the main ring and smaller ones."
                      This popup already explained the small per-aircraft
                      badges below (ring = that aircraft's Reminder urgency,
                      number = its AD status) but never mentioned the big
                      ring above the popup trigger itself -- the one thing
                      readers can see without scrolling while this is open.
                      No new mockup widget for it: unlike the per-aircraft
                      badges (buried further down a list), the real ring is
                      already visible right above where this popup opens. */}
                  <Text style={[styles.ringLegendHeader, { color: tokens.t2, fontSize: fs(13) }]}>The big ring above is your whole fleet at a glance — the AD and Reminders sections below it break down exactly what it's counting.</Text>
                  <Text style={[styles.ringLegendHeader, { color: tokens.t2, fontSize: fs(13), marginTop: 14 }]}>If you have more than one aircraft, each one below also gets its own small ring and number:</Text>
                  <Text style={[styles.ringLegendHeader, { color: tokens.t2, fontSize: fs(13), marginTop: 6 }]}>The ring shows that aircraft's Reminder urgency:</Text>
                  <PopupRingSwatchRow
                    tokens={tokens}
                    items={[
                      <PopupRingSwatch key="ontrack" ringOnly color={tokens.grn} label="On track" tokens={tokens} fs={fs} />,
                      <PopupRingSwatch key="soon" ringOnly color={tokens.amb} label="Due soon" tokens={tokens} fs={fs} />,
                      <PopupRingSwatch key="overdue" ringOnly color={tokens.red} label="Overdue" tokens={tokens} fs={fs} />,
                    ]}
                  />
                  <Text style={[styles.ringLegendHeader, { color: tokens.t2, fontSize: fs(13), marginTop: 14 }]}>The number shows that aircraft's own AD status:</Text>
                  <PopupRingSwatchRow
                    tokens={tokens}
                    items={[
                      <PopupRingSwatch key="open" color={tokens.amb} label="Open" tokens={tokens} fs={fs} />,
                      <PopupRingSwatch key="compliant" checkmark color={tokens.grn} label="Compliant" tokens={tokens} fs={fs} />,
                    ]}
                  />
                </View>
              }
              forceOnce
              iconSize={fs(15)}
            />
          </View>

          {aircraft.length === 0 ? (
            <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(14) }]}>No aircraft saved yet.</Text>
          ) : (
            <>
              {/* Fleet compliance card -- Premium only. RC: "you said you
                  were going to redesign Pro to have a similar feel as
                  Fleet, but it didn't get done" -- this aggregate ring/
                  legend/stat-box card was rendering unconditionally for
                  Pro too (found live: a Pro account showed the full
                  multi-aircraft dashboard). Pro is sold as ONE aircraft,
                  not a fleet, so an aggregate proportional-compliance
                  summary doesn't apply -- the per-aircraft RowStatusBadge
                  in the list below already carries the exact same color
                  language (ring = reminder urgency, number = open-AD
                  count) at the single-aircraft level, which is all Pro
                  needs. "Similar feel" means the same colors/ring
                  vocabulary, not a shrunken copy of the fleet dashboard
                  itself -- see FleetRing's own comment for why this card
                  exists in the first place (RC's reference image, built
                  fresh rather than reusing the app's existing plain-badge
                  pattern). Ring + legend are the same three real, separate
                  aircraft-level buckets (compliant/open/overdue) that
                  always sum to the fleet total; the stat boxes below are
                  ITEM-level sums (openAdCount/overdueReminderCount added
                  across aircraft), which is why their numbers can differ
                  from the legend's. */}
              {isPro && !isPremium && aircraft.length > 0 && (
                <ProHero
                  aircraft={aircraft[0]}
                  reminderUrgency={reminderUrgency[aircraft[0].aircraftId] ?? 'clear'}
                  nextDueDays={nextDueDays}
                  dueSoonCount={dueSoonCount}
                  tokens={tokens}
                  fs={fs}
                  onPressRing={() => handleQuickComplied(aircraft[0])}
                />
              )}

              {isPremium && (
                <View style={[styles.fleetCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                  <View style={styles.fleetCardTop}>
                    <FleetRing
                      compliantCount={totalCompliantAds}
                      openCount={totalOpenAds}
                      overdueCount={totalOverdue}
                      aircraftTotal={aircraft.length}
                      tokens={tokens}
                      fs={fs}
                    />
                    <View style={styles.legend}>
                      {/* RC, real device: "the top right area with the dots
                          can be for AD info (a small 'AD' above those). the
                          three blocks below that can be for Reminders."
                          Splits what used to be one flat 3-row legend
                          (mixing AD compliance state with reminder due-
                          state, previously just labeled by domain per RC's
                          own earlier fix) into two clearly separate blocks:
                          this legend is AD-only now, Overdue Reminder moved
                          down into the stat-box row below where the rest of
                          the reminder data already lives -- removes the
                          Open AD / OPEN ADS duplication RC flagged as
                          wasted space, since AD counts now appear exactly
                          once each. The ring itself is untouched and still
                          factors in both domains (its color/proportions
                          already read from compliantCount/openCount/
                          overdueCount together) -- it's the umbrella
                          "fleet snapshot," these two labeled blocks are its
                          breakdown.

                          RC, round 2: "make just boxes for the Compliant and
                          Open AD counts, like the Reminder ones, and stack
                          them vertically on the right. then the main ring
                          can take up more of that open space." Swapped the
                          dot+label legend rows for the same StatBox already
                          used below (visual parity between the two now-
                          separate AD/Reminders blocks was the whole point),
                          stacked in a column instead of Reminders' row since
                          there are only 2 here, not 3 -- and freed the
                          horizontal space by growing the ring itself
                          (RING_SIZE) rather than just leaving a gap. */}
                      <Text style={[styles.legendSectionLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>AD</Text>
                      <View style={styles.adBoxColumn}>
                        <StatBox value={totalCompliantAds} label="COMPLIANT" color={tokens.grn} tokens={tokens} fs={fs} />
                        <StatBox value={totalOpenAds} label="OPEN" color={tokens.amb} tokens={tokens} fs={fs} />
                      </View>
                    </View>
                  </View>
                  <View style={[styles.remindersSection, { borderTopColor: tokens.bdr }]}>
                    <Text style={[styles.legendSectionLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>REMINDERS</Text>
                    <View style={styles.statBoxRow}>
                      <StatBox value={totalOverdue} label="OVERDUE" color={tokens.red} tokens={tokens} fs={fs} />
                      <StatBox value={dueSoonCount} label="DUE SOON" color={tokens.amb} tokens={tokens} fs={fs} />
                      <StatBox value={nextDueDays !== null ? `${nextDueDays}d` : '—'} label="NEXT DUE" color={tokens.grn} tokens={tokens} fs={fs} />
                    </View>
                  </View>
                </View>
              )}

              {/* RC: "is there another way to sort? if not, we probably
                  don't need the words. we can always just explain the
                  sort in the 'how this works' info icon." There's no sort
                  picker -- urgency-first is the only order -- so the
                  trailing label was explaining a fact with no alternative
                  to distinguish it from, moved into the intro popup above
                  instead of staying permanently on screen. */}
              <Text style={[styles.aircraftSectionTitle, { color: tokens.t3, fontSize: fs(11.5) }]}>AIRCRAFT</Text>
              <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {sortedAircraft.map((a, i) => {
                  const canEdit = a.role === 'owner' || a.role === 'editor'
                  const isExpanded = expandedId === a.aircraftId
                  const details = expandedDetails[a.aircraftId]
                  const acLabel = a.nickname || `${a.make} ${a.model}`
                  const primaryLabel = a.nickname || `${a.make} ${a.model}`
                  const secondaryLabel = [`${a.make} ${a.model}`, a.typeDesignator].filter(Boolean).join(' · ')
                  return (
                  <View
                    key={a.aircraftId}
                    style={i < sortedAircraft.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }}
                  >
                    <SwipeToDelete
                      onDelete={() => handleRemove(a)}
                      onPress={() => toggleExpand(a.aircraftId)}
                      disabled={a.role !== 'owner'}
                    >
                    <View style={[styles.row, { backgroundColor: tokens.bg2 }]}>
                      <View style={[styles.rowIconBadge, { backgroundColor: tokens.bdim }]}>
                        <Icon name="airplane" size={fs(15)} color={tokens.t2} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={styles.rowMakeLine}>
                          <Text style={[styles.rowMake, { color: tokens.t1, fontSize: fs(14.5) }]}>{primaryLabel}</Text>
                          {a.role !== 'owner' && (
                            <View style={[styles.roleBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}>
                              <Text style={[styles.roleBadgeText, { color: tokens.t3, fontSize: fs(10) }]}>
                                {a.role === 'editor' ? 'EDITOR' : 'VIEWER'}
                              </Text>
                            </View>
                          )}
                        </View>
                        <Text style={[styles.rowNickname, { color: tokens.t3, fontSize: fs(12.5) }]}>{secondaryLabel}</Text>
                        {(a.currentHobbsHours != null || canEdit) && (
                          <Pressable
                            style={styles.hobbsRowMini}
                            onPress={(e) => { e.stopPropagation(); if (canEdit) setHobbsEditing(a) }}
                            hitSlop={6}
                          >
                            <Icon name="speedometer" size={fs(11)} color={canEdit ? tokens.blu : tokens.t4} />
                            <Text style={{ color: canEdit ? tokens.blu : tokens.t3, fontSize: fs(11.5) }}>
                              {a.currentHobbsHours != null ? `${a.currentHobbsHours}` : 'Set'}
                            </Text>
                          </Pressable>
                        )}
                      </View>
                      <Pressable
                        onPress={(e) => { e.stopPropagation(); handleQuickComplied(a) }}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel="View open ADs"
                      >
                        <RowStatusBadge openAdCount={a.openAdCount} reminderUrgency={reminderUrgency[a.aircraftId] ?? 'clear'} tokens={tokens} fs={fs} />
                      </Pressable>
                      {/* No edit pencil here -- best part is no part. RC:
                          "we don't need this edit button here. the
                          editing takes place once inside the a/c page."
                          EditAircraftModal now lives only in
                          my-aircraft/[id].tsx. */}
                      <Icon name={isExpanded ? 'chevron.down' : 'chevron.right'} size={fs(14)} color={tokens.t4} />
                    </View>
                    </SwipeToDelete>

                    {isExpanded && (
                      <View style={[styles.expandPanel, { borderTopColor: tokens.bdr }]}>
                        {!details || details === 'loading' ? (
                          <ActivityIndicator color={tokens.blu} style={{ marginVertical: 10 }} />
                        ) : (
                          <>
                            {/* RC: "whatever data these are representing,
                                let's show that in the dropdown when it's
                                tapped on" -- the row's own status pill says
                                a count, this says which ones. Just number
                                chips, not the full subject-heading rows
                                that were here before "keep all things
                                clean" removed them -- complied ADs get a
                                green check + dimmed text so open vs. done
                                reads at a glance without a second label. */}
                            <Text style={[styles.expandGroupLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>APPLICABLE ADs</Text>
                            {details.ads.length === 0 ? (
                              <Text style={[styles.expandEmpty, { color: tokens.t3, fontSize: fs(12.5) }]}>None matched.</Text>
                            ) : (
                              <View style={styles.adChipWrap}>
                                {details.ads.map((n) => (
                                  <Pressable
                                    key={n.id}
                                    style={[styles.adChip, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}
                                    onPress={() => {
                                      // RC: no way to mark an AD complied
                                      // without drilling into the aircraft's
                                      // own detail page -- tapping this chip
                                      // used to just navigate to the generic
                                      // AD page, a dead end for that action.
                                      // Now offers both, right from the list.
                                      if (!canEdit) { router.push(`/ad/${n.adNumber}` as any); return }
                                      confirm({
                                        title: `AD ${n.adNumber}`,
                                        choices: [
                                          {
                                            label: n.compliedAt ? 'Un-mark Complied' : 'Mark Complied',
                                            onPress: () => handleToggleCompliedFromList(a.aircraftId, n),
                                          },
                                          { label: 'View AD Details', onPress: () => router.push(`/ad/${n.adNumber}` as any) },
                                        ],
                                      })
                                    }}
                                  >
                                    {n.compliedAt && <Icon name="checkmark.circle.fill" size={fs(10)} color={tokens.grn} />}
                                    <Text style={[styles.adChipText, { color: n.compliedAt ? tokens.t3 : tokens.blu, fontSize: fs(11.5) }]}>
                                      {n.adNumber}
                                    </Text>
                                  </Pressable>
                                ))}
                              </View>
                            )}

                            <Text style={[styles.expandGroupLabel, { color: tokens.t3, fontSize: fs(10.5), marginTop: 10 }]}>REMINDERS</Text>
                            {details.reminders.length === 0 ? (
                              <Text style={[styles.expandEmpty, { color: tokens.t3, fontSize: fs(12.5) }]}>None set.</Text>
                            ) : (
                              [...details.reminders]
                                .sort((x, y) => daysUntil(x.dueDate) - daysUntil(y.dueDate))
                                .slice(0, 4)
                                .map((r) => {
                                  const days = daysUntil(r.dueDate)
                                  const overdue = days < 0
                                  const soon = days >= 0 && days <= 30
                                  // RC: "again, we don't need the word here,
                                  // just use colors for these day counts" --
                                  // and separately, "green when good, amber
                                  // when w/n a certain number of days from
                                  // due... red when overdue," same 3-color
                                  // scheme as the ring and the detail
                                  // screen's own reminders list.
                                  const color = overdue ? tokens.red : soon ? tokens.amb : tokens.grn
                                  return (
                                    <View key={r.id} style={styles.expandRow}>
                                      <Icon name="hourglass" size={fs(12)} color={color} />
                                      <Text style={[styles.expandRowTitle, { color: tokens.t1, fontSize: fs(12.5) }]}>{r.title}</Text>
                                      <Text style={[styles.expandRowSub, { color, fontSize: fs(12) }]}>
                                        {overdue ? `${Math.abs(days)}d` : `${days}d`}
                                      </Text>
                                    </View>
                                  )
                                })
                            )}
                            {details.reminders.length > 4 && (
                              <Text style={[styles.expandMore, { color: tokens.t3, fontSize: fs(11.5) }]}>+{details.reminders.length - 4} more</Text>
                            )}

                            <Pressable
                              style={[styles.manageButton, { borderColor: tokens.bdr }]}
                              onPress={() => router.push(`/my-aircraft/${a.aircraftId}` as any)}
                            >
                              <Text style={[styles.manageButtonText, { color: tokens.blu, fontSize: fs(13) }]}>
                                {canEdit ? `Manage ${acLabel}` : `Open ${acLabel}`}
                              </Text>
                              <Icon name="arrow.up.right" size={fs(12)} color={tokens.blu} />
                            </Pressable>
                          </>
                        )}
                      </View>
                    )}
                  </View>
                  )
                })}
              </View>
              {/* A downgraded account must never just silently come up
                  short an aircraft -- "where did my other planes go" is a
                  support ticket and, worse, looks like data loss. Nothing
                  IS deleted; this says so on the screen where they'd
                  notice, without needing to tap anything first. */}
              {/* No inline chooser here any more -- AircraftDowngradeGate
                  is mounted at the app root and covers this screen along
                  with every other one, so a second copy would just be the
                  same modal's content rendered twice underneath it. */}
            </>
          )}

          {/* No manual "enter invite code" UI -- best part is no part.
              Joining a shared aircraft happens entirely by tapping the
              link an owner shares (join/[token].tsx), same as folders;
              there's nothing left for the receiver to do on this screen. */}
          {/* RC: "let's keep this whole 'add a/c' area collapsed. just a
              small 'Add Aircraft +' which can expand when needed... It's
              busy enough w/o this Add feature always open." */}
          {/* RC: "when i clicked Add Aircraft button, i got this popup, and
              that's not the right time/place for this note. in Pro, clicking
              the AA button should show a CTA informing of the 'one a/c at a
              time' situation. It should NOT present the new a/c form in Pro
              tier until the previous a/c has been deleted." The form used to
              open regardless and only rejected the add at submit time
              (handleAdd's cap Alert) -- so a Pro user already at the cap got
              the whole form, the Model-vs-Type forceOnce popup firing on
              top of it, and no hint anything was wrong until after they'd
              filled it all in. Now the cap is enforced at the point of
              entry, and the form (with its popup) never mounts at all. */}
          {addFormOpen && atProCap ? (
            <View style={[styles.capCard, { backgroundColor: tokens.bg2, borderColor: tokens.gold }]}>
              <Icon name="airplane" size={fs(24)} color={tokens.gold} />
              <Text style={[styles.capTitle, { color: tokens.t1, fontSize: fs(15) }]}>
                One aircraft at a time on Pro
              </Text>
              {/* Only ever the at-cap-but-not-OVER-cap case now: being over
                  cap puts AircraftDowngradeGate's blocking modal on top of
                  this screen, so the "you have hidden aircraft" variant this
                  used to carry can't be reached from here any more. */}
              <Text style={[styles.capBody, { color: tokens.t3, fontSize: fs(13.5) }]}>
                To swap to a different aircraft, delete this one first — swipe left on it in the list above. Premium tracks as many as you want, all at once.
              </Text>
              <Pressable
                style={[styles.capBtn, { backgroundColor: tokens.gold }]}
                onPress={() => router.push('/paywall?tier=premium' as any)}
              >
                <Text style={[styles.capBtnText, { fontSize: fs(14) }]}>See Premium</Text>
              </Pressable>
              <Pressable onPress={() => setAddFormOpen(false)} hitSlop={8}>
                <Text style={[styles.capDismiss, { color: tokens.t3, fontSize: fs(13) }]}>Not now</Text>
              </Pressable>
            </View>
          ) : addFormOpen ? (
            <AddAircraftForm
              aircraftCount={aircraft.length}
              onAdded={handleAircraftAdded}
              onCancel={() => setAddFormOpen(false)}
              tokens={tokens}
              fs={fs}
            />
          ) : (
            <Pressable
              style={[styles.addTrigger, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, marginTop: 20 }]}
              onPress={() => {
                // Free/Plus have a 0 aircraft cap (aircraftCapForTier above),
                // so atProCap is true for them too -- without this check they
                // fell into the SAME branch as a Pro user at cap and saw its
                // Pro-specific "One aircraft at a time on Pro... upgrade to
                // Premium" copy despite never having had Pro access at all.
                // Route them to the real paywall instead of opening a form
                // (or a Pro-flavored CTA) they can't use. hasProAccess, not
                // bare isPro -- same class of bug as the two other isPro
                // checks in this file, fixed together (2026-08-14 audit).
                if (!hasProAccess) {
                  router.push('/paywall')
                  return
                }
                setAddFormOpen(true)
              }}
            >
              <Icon name="plus" size={fs(14)} color={tokens.blu} />
              <Text style={[styles.addTriggerText, { color: tokens.blu, fontSize: fs(14) }]}>Add Aircraft</Text>
            </Pressable>
          )}
        </ScrollView>
        </TabletContainer>
      )}

      <HobbsUpdateModal
        visible={!!hobbsEditing}
        aircraftId={hobbsEditing?.aircraftId ?? ''}
        initialHours={hobbsEditing?.currentHobbsHours ?? null}
        updatedAt={null}
        onClose={() => setHobbsEditing(null)}
        onSaved={(hours) => {
          setAircraft((prev) => prev.map((x) => (x.aircraftId === hobbsEditing?.aircraftId ? { ...x, currentHobbsHours: hours } : x)))
          setHobbsEditing(null)
        }}
      />
    </KeyboardAvoidingView>
  )
}

export default function MyAircraftScreen() {
  return <MyAircraftBody />
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // Lock-screen guard styles (hasProAccess), matching study.tsx's own copy. Own
  // `lockCenter` (not the shared `center` above, used by the loading
  // spinner) so adding padding/gap here can't shift that unrelated view.
  lockCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 300, paddingHorizontal: 24 },
  upgradeBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, marginTop: 10 },
  upgradeBtnText: { color: '#fff', fontWeight: '700' },
  content: { padding: 16, paddingBottom: 40 },
  introRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 },
  intro: { lineHeight: 18 },
  empty: { textAlign: 'center', paddingVertical: 20 },
  list: { borderRadius: 12, borderWidth: 1, marginBottom: 20, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10 },
  rowIconBadge: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  rowMakeLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  rowMake: { fontWeight: '600' },
  rowNickname: { marginTop: 2 },
  hobbsRowMini: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  roleBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  roleBadgeText: { fontWeight: '700', letterSpacing: 0.4 },
  rowStatusRing: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  rowStatusNum: { fontWeight: '700' },
  // InfoPopup ring/number legend -- real miniature widgets, not text.
  ringLegendSection: { marginTop: 4 },
  ringLegendHeader: { fontWeight: '500' },
  ringLegendRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 10 },
  ringLegendRowItem: { flexDirection: 'row', alignItems: 'center' },
  ringLegendTick: { width: 2, height: 28, borderRadius: 1, marginHorizontal: 12 },
  ringLegendItem: { alignItems: 'center', gap: 4 },
  ringLegendCircle: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  ringLegendNum: { fontWeight: '700' },
  ringLegendItemLabel: { fontWeight: '500' },
  // Fleet compliance card -- ring + legend on top, three stat boxes below.
  fleetCard: { borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 16, gap: 14 },
  fleetCardTop: { flexDirection: 'row', alignItems: 'center', gap: 20, paddingLeft: 6 },
  ringTickWrap: { alignItems: 'center' },
  ringTick: { width: 6, height: 17, borderRadius: 3, marginTop: 4 },
  ringCenter: { alignItems: 'center', justifyContent: 'center' },
  ringCenterNum: { fontWeight: '700' },
  ringCenterUnit: { letterSpacing: 0.8, marginTop: -2, fontWeight: '600' },
  legend: { flex: 1, gap: 10 },
  adBoxColumn: { flex: 1, gap: 8 },
  // Small caps header over the AD legend and the Reminders stat-box row --
  // the AD/Reminders split RC asked for, each block labeled by its own
  // domain instead of reading as one undifferentiated card.
  legendSectionLabel: { fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: -2 },
  remindersSection: { gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14 },
  // RC: "give these some more space, they're cramped and wrapping lines
  // unnec." Root cause wasn't the padding -- proHeroCard sets alignItems:
  // 'center', which in flexbox makes a child size to its CONTENT instead of
  // stretching, so this row was only ever as wide as three shrink-wrapped
  // boxes and "OPEN ITEMS" wrapped to two lines inside one. alignSelf
  // 'stretch' opts back out of that, giving each box the card's full width
  // to divide up (no-op for Premium's fleetCard, which never centered).
  keepList: { alignSelf: 'stretch', gap: 8, marginTop: 6 },
  keepRow: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    borderRadius: 10, borderWidth: 1, paddingVertical: 11, paddingHorizontal: 12,
  },
  keepRowText: { flex: 1, fontWeight: '600' },
  keepRowAction: { fontWeight: '700' },
  capFootnote: { marginTop: 2 },

  capCard: {
    borderRadius: 16, borderWidth: 1, padding: 20, marginTop: 20,
    alignItems: 'center', gap: 10,
  },
  capTitle: { fontWeight: '700', textAlign: 'center' },
  capBody: { textAlign: 'center', lineHeight: 19 },
  capBtn: { borderRadius: 12, paddingHorizontal: 22, paddingVertical: 11, marginTop: 4 },
  capBtnText: { color: '#000', fontWeight: '700' },
  capDismiss: { fontWeight: '600', marginTop: 2 },

  statBoxRow: { flexDirection: 'row', gap: 8, alignSelf: 'stretch' },
  statBox: { flex: 1, borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 4, alignItems: 'center', gap: 3 },
  statBoxValue: { fontWeight: '700' },
  statBoxLabel: { letterSpacing: 0.4, fontWeight: '600' },
  // Pro's single-aircraft hero -- same card language as fleetCard above,
  // one big RowStatusBadge-style ring instead of the proportional FleetRing.
  proHeroCard: { borderRadius: 16, borderWidth: 1, padding: 20, marginBottom: 16, alignItems: 'center', gap: 14 },
  proHeroRing: { width: PRO_HERO_RING_SIZE, height: PRO_HERO_RING_SIZE, borderRadius: PRO_HERO_RING_SIZE / 2, borderWidth: 4, alignItems: 'center', justifyContent: 'center' },
  proHeroNum: { fontWeight: '700' },
  proHeroLabel: { fontWeight: '700' },
  aircraftSectionTitle: { fontWeight: '700', letterSpacing: 0.6, marginBottom: 8, paddingHorizontal: 2 },
  expandPanel: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 10 },
  expandGroupLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 },
  expandEmpty: { marginBottom: 2 },
  adChipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  adChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 4 },
  adChipText: { fontWeight: '600' },
  expandRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  expandRowTitle: { fontWeight: '600' },
  expandRowSub: { flex: 1 },
  expandMore: { marginTop: 2 },
  manageButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderRadius: 9, paddingVertical: 9, marginTop: 12,
  },
  manageButtonText: { fontWeight: '600' },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 },
  formCard: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  suggestBox: { borderWidth: 1, borderRadius: 8, marginTop: 4, overflow: 'hidden' },
  suggestRow: { paddingHorizontal: 12, paddingVertical: 9 },
  typeDesignatorRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  addButton: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  addButtonText: { color: '#fff', fontWeight: '600', fontSize: 14.5 },
  cancelAddBtn: { alignItems: 'center', paddingVertical: 10, marginTop: 2 },
  addTrigger: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 12, borderWidth: 1, paddingVertical: 13 },
  addTriggerText: { fontWeight: '600' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, gap: 4 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { fontWeight: '700' },
})
