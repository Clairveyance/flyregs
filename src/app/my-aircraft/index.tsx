import { useState, useRef, useEffect, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert, Modal } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { useTheme, type ThemeTokens } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { TabletContainer } from '@/components/TabletContainer'
import { supabase } from '@/lib/supabase'
import { suggestTypeDesignator } from '@/lib/aircraftModels'
import { backfillAircraftAds, getAircraftAdNotifications, type AircraftAdNotification } from '@/lib/adNotifications'
import { getAircraftReminders, type AircraftReminder } from '@/lib/adParts'
import {
  getFleetSummary,
  type FleetAircraftSummary,
} from '@/lib/aircraftSharing'
import { SwipeToDelete } from '@/components/SwipeToDelete'
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
const RING_SIZE = 152
const RING_TICKS = 32

function FleetRing({
  compliantCount, openCount, overdueCount, total, tokens, fs,
}: {
  compliantCount: number; openCount: number; overdueCount: number; total: number
  tokens: ThemeTokens; fs: (n: number) => number
}) {
  const nOverdue = total > 0 ? Math.round((overdueCount / total) * RING_TICKS) : 0
  const nOpen = total > 0 ? Math.round((openCount / total) * RING_TICKS) : 0
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
  return (
    <View style={{ width: RING_SIZE, height: RING_SIZE }}>
      {tickColors.map((color, i) => (
        <View
          key={i}
          style={[StyleSheet.absoluteFill, styles.ringTickWrap, { transform: [{ rotate: `${i * angleStep}deg` }] }]}
        >
          <View style={[styles.ringTick, { backgroundColor: color }]} />
        </View>
      ))}
      <View style={[StyleSheet.absoluteFill, styles.ringCenter]}>
        <Text style={[styles.ringCenterNum, { color: worstColor, fontSize: fs(32) }]}>{total}</Text>
        <Text style={[styles.ringCenterUnit, { color: tokens.t4, fontSize: fs(11) }]}>AIRCRAFT</Text>
      </View>
    </View>
  )
}

function LegendRow({ color, label, count, tokens, fs }: { color: string; label: string; count: number; tokens: ThemeTokens; fs: (n: number) => number }) {
  return (
    <View style={styles.legendRow}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={[styles.legendLabel, { color: tokens.t2, fontSize: fs(13) }]}>{label}</Text>
      <Text style={[styles.legendCount, { color: tokens.t1, fontSize: fs(13.5) }]}>{count}</Text>
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

function ProHero({
  aircraft, reminderUrgency, nextDueDays, tokens, fs,
}: {
  aircraft: FleetAircraftSummary
  reminderUrgency: 'overdue' | 'soon' | 'clear'
  nextDueDays: number | null
  tokens: ThemeTokens
  fs: (n: number) => number
}) {
  const ringColor = reminderUrgency === 'overdue' ? tokens.red : reminderUrgency === 'soon' ? tokens.amb : tokens.grn
  const numColor = aircraft.openAdCount > 0 ? tokens.amb : tokens.grn
  const label = aircraft.nickname || `${aircraft.make} ${aircraft.model}`
  return (
    <View style={[styles.proHeroCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
      <View style={[styles.proHeroRing, { borderColor: ringColor }]}>
        {aircraft.openAdCount > 0 ? (
          <Text style={[styles.proHeroNum, { color: numColor, fontSize: fs(30) }]}>{aircraft.openAdCount}</Text>
        ) : (
          <Icon name="checkmark" size={fs(34)} color={numColor} weight="bold" />
        )}
      </View>
      <Text style={[styles.proHeroLabel, { color: tokens.t1, fontSize: fs(16) }]}>{label}</Text>
      <View style={styles.statBoxRow}>
        <StatBox value={aircraft.overdueReminderCount} label="OVERDUE" color={tokens.red} tokens={tokens} fs={fs} />
        <StatBox value={aircraft.openAdCount} label="OPEN ITEMS" color={tokens.amb} tokens={tokens} fs={fs} />
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

export default function MyAircraftScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro, isPremium } = useAuth()
  const [aircraft, setAircraft] = useState<FleetAircraftSummary[]>([])
  const [loading, setLoading] = useState(true)
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
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [nickname, setNickname] = useState('')
  const [typeDesignator, setTypeDesignator] = useState('')
  const [year, setYear] = useState<number | null>(null)
  const [yearPickerOpen, setYearPickerOpen] = useState(false)
  const typeDesignatorEdited = useRef(false)
  const [saving, setSaving] = useState(false)
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

  const handleModelChange = (text: string) => {
    setModel(text)
    if (!typeDesignatorEdited.current) setTypeDesignator(suggestTypeDesignator(text) ?? '')
  }

  const handleTypeDesignatorChange = (text: string) => {
    typeDesignatorEdited.current = true
    setTypeDesignator(text)
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
            const urgency: Record<string, 'overdue' | 'soon' | 'clear'> = {}
            lists.forEach((list, i) => {
              let worst: 'overdue' | 'soon' | 'clear' = 'clear'
              for (const r of list) {
                const days = daysUntil(r.dueDate)
                if (days >= 0 && (soonest === null || days < soonest)) soonest = days
                if (days < 0) worst = 'overdue'
                else if (days <= 30 && worst !== 'overdue') worst = 'soon'
              }
              urgency[rows[i].aircraftId] = worst
            })
            setNextDueDays(soonest)
            setReminderUrgency(urgency)
          })
          .catch(() => { setNextDueDays(null); setReminderUrgency({}) })
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

  const handleAdd = async () => {
    if (!session) {
      router.push('/auth')
      return
    }
    if (!isPro) {
      router.push('/paywall')
      return
    }
    // Pro is capped at 1 saved aircraft (most owners have exactly one);
    // Premium is unlimited -- see flyregs_decisions.md's pricing pivot.
    if (!isPremium && aircraft.length >= PRO_AIRCRAFT_CAP) {
      Alert.alert(
        'Aircraft limit reached',
        `Pro includes ${PRO_AIRCRAFT_CAP} saved aircraft. Upgrade to Premium for unlimited.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Upgrade to Premium', onPress: () => router.push('/paywall?tier=premium') },
        ]
      )
      return
    }
    const trimmedMake = make.trim()
    const trimmedType = typeDesignator.trim()
    // Some aircraft have no separate marketing name (a Pilatus PC-12 isn't
    // "known by" anything other than its own type designator) -- RC, live:
    // "i don't think that a/c has a 'name', i think it's just known by
    // that model/type designator." Rather than force a fake distinct Model
    // value in that case, fall back to the type designator itself.
    const trimmedModel = model.trim() || trimmedType
    if (!trimmedMake || !trimmedModel) {
      Alert.alert('Make and model required', 'Enter both the aircraft make and model.')
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
      Alert.alert('Type designator required', 'Enter the FAA type designator (e.g. PA-28-181, 172S) so we can match Airworthiness Directives correctly.')
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
      Alert.alert('Could not add aircraft', error.message)
      return
    }
    setMake('')
    setModel('')
    setNickname('')
    setTypeDesignator('')
    setYear(null)
    typeDesignatorEdited.current = false
    setAddFormOpen(false)
    load()
    // Backfill against the FULL AD corpus, not just future ones -- a
    // freshly-added aircraft otherwise starts with an empty Applicable ADs
    // list even if real ADs already exist for it. See adNotifications.ts's
    // own comment. Fires after the list already reloaded above so this
    // never blocks the aircraft itself from saving.
    if (inserted) {
      backfillAircraftAds(inserted.id)
        .then((count) => {
          if (count > 0) {
            Alert.alert(
              'Aircraft added',
              `Found ${count} existing Airworthiness Directive${count === 1 ? '' : 's'} that may apply — see its Applicable ADs list.`
            )
          }
        })
        .catch((e) => {
          // Best-effort, but not silent -- the aircraft itself saved fine,
          // this only affects whether its AD list is pre-populated yet.
          console.error('AD backfill failed for new aircraft:', e?.message ?? e)
        })
    }
  }

  // RC: swipe-to-delete "with two step CTA popup verification explaining
  // what will be deleted" -- this previously had NO confirm at all before
  // deleting a whole aircraft record (the riskiest delete on this screen),
  // which matters even more now that a swipe, not just a deliberate trash
  // tap, can trigger it.
  const handleRemove = (a: FleetAircraftSummary) => {
    const label = a.nickname || `${a.make} ${a.model}`
    Alert.alert(
      `Delete ${label}?`,
      'This permanently removes the aircraft and its equipment, reminders, and AD history. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('user_aircraft').delete().eq('id', a.aircraftId)
            setAircraft((prev) => prev.filter((x) => x.aircraftId !== a.aircraftId))
          },
        },
      ]
    )
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
  // Ring/legend counts are AIRCRAFT counted in exactly one bucket each (its
  // worst status) -- e.g. an aircraft with both an overdue reminder and an
  // open AD counts once, under Overdue, not both -- so the three numbers
  // always sum to the fleet total. The stat-box numbers above (totalOpenAds/
  // totalOverdue) are different on purpose: those are ITEM counts, which
  // can outnumber the aircraft that have them.
  const overdueCatCount = aircraft.filter((a) => a.overdueReminderCount > 0).length
  const openCatCount = aircraft.filter((a) => a.overdueReminderCount === 0 && a.openAdCount > 0).length
  const compliantCount = aircraft.length - overdueCatCount - openCatCount
  // RC: matches the reference image's own "Sorted by urgency" list order --
  // overdue first, then open, then compliant; alphabetical by make/model as
  // the tiebreak within each bucket (get_fleet_summary()'s own default
  // order, preserved via a stable sort rather than re-sorted).
  const urgency = (a: FleetAircraftSummary) => (a.overdueReminderCount > 0 ? 0 : a.openAdCount > 0 ? 1 : 2)
  const sortedAircraft = [...aircraft].sort((a, b) => urgency(a) - urgency(b))

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={screenTitle} onBack={() => router.back()} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
        <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="interactive">
          <View style={styles.introRow}>
            <Text style={[styles.intro, { color: tokens.t3, fontSize: fs(13) }]}>How this works</Text>
            <InfoPopup
              id="my-aircraft-intro"
              title={screenTitle}
              body={[
                'Save the aircraft you fly or maintain to get alerted when a new or updated Airworthiness Directive applies to them, instead of scanning the full AD list yourself.',
                'Premium can share an aircraft with other Premium accounts as a viewer or editor.',
                'Sorted by urgency — overdue first, then open items, then compliant.',
              ]}
              footer={
                <View style={styles.ringLegendSection}>
                  <Text style={[styles.ringLegendHeader, { color: tokens.t2, fontSize: fs(13) }]}>The ring shows the urgency status of Reminders:</Text>
                  <PopupRingSwatchRow
                    tokens={tokens}
                    items={[
                      <PopupRingSwatch key="ontrack" ringOnly color={tokens.grn} label="On track" tokens={tokens} fs={fs} />,
                      <PopupRingSwatch key="soon" ringOnly color={tokens.amb} label="Due soon" tokens={tokens} fs={fs} />,
                      <PopupRingSwatch key="overdue" ringOnly color={tokens.red} label="Overdue" tokens={tokens} fs={fs} />,
                    ]}
                  />
                  <Text style={[styles.ringLegendHeader, { color: tokens.t2, fontSize: fs(13), marginTop: 14 }]}>The number shows the count and status of ADs:</Text>
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
                  tokens={tokens}
                  fs={fs}
                />
              )}

              {isPremium && (
                <View style={[styles.fleetCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                  <View style={styles.fleetCardTop}>
                    <FleetRing
                      compliantCount={compliantCount}
                      openCount={openCatCount}
                      overdueCount={overdueCatCount}
                      total={aircraft.length}
                      tokens={tokens}
                      fs={fs}
                    />
                    <View style={styles.legend}>
                      <LegendRow color={tokens.grn} label="Compliant" count={compliantCount} tokens={tokens} fs={fs} />
                      <LegendRow color={tokens.amb} label="Open AD" count={openCatCount} tokens={tokens} fs={fs} />
                      <LegendRow color={tokens.red} label="Overdue" count={overdueCatCount} tokens={tokens} fs={fs} />
                    </View>
                  </View>
                  <View style={styles.statBoxRow}>
                    <StatBox value={totalOverdue} label="OVERDUE" color={tokens.red} tokens={tokens} fs={fs} />
                    <StatBox value={totalOpenAds} label="OPEN ITEMS" color={tokens.amb} tokens={tokens} fs={fs} />
                    <StatBox value={nextDueDays !== null ? `${nextDueDays}d` : '—'} label="NEXT DUE" color={tokens.grn} tokens={tokens} fs={fs} />
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
                      </View>
                      <RowStatusBadge openAdCount={a.openAdCount} reminderUrgency={reminderUrgency[a.aircraftId] ?? 'clear'} tokens={tokens} fs={fs} />
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
                                    onPress={() => router.push(`/ad/${n.adNumber}` as any)}
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
            <>
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), marginTop: 20 }]}>
                ADD AIRCRAFT{!isPremium ? ` (${aircraft.length}/${PRO_AIRCRAFT_CAP} — Premium for unlimited)` : ''}
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
                  style={[styles.input, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }]}
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
              </View>
            </>
          ) : (
            <Pressable
              style={[styles.addTrigger, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, marginTop: 20 }]}
              onPress={() => setAddFormOpen(true)}
            >
              <Icon name="plus" size={fs(14)} color={tokens.blu} />
              <Text style={[styles.addTriggerText, { color: tokens.blu, fontSize: fs(14) }]}>Add Aircraft</Text>
            </Pressable>
          )}
        </ScrollView>
        </TabletContainer>
      )}

      <YearPickerModal
        visible={yearPickerOpen}
        initialYear={year}
        onClose={() => setYearPickerOpen(false)}
        onSelect={setYear}
        tokens={tokens}
        fs={fs}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
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
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot: { width: 9, height: 9, borderRadius: 4.5 },
  legendLabel: { flex: 1 },
  legendCount: { fontWeight: '700' },
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
  addTrigger: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 12, borderWidth: 1, paddingVertical: 13 },
  addTriggerText: { fontWeight: '600' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, gap: 4 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { fontWeight: '700' },
})
