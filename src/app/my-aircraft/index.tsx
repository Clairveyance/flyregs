import { useEffect, useState, useRef } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert, Modal } from 'react-native'
import { router } from 'expo-router'
import { useTheme, type ThemeTokens } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { TabletContainer } from '@/components/TabletContainer'
import { supabase } from '@/lib/supabase'
import { suggestTypeDesignator } from '@/lib/aircraftModels'
import { backfillAircraftAds } from '@/lib/adNotifications'
import { getAircraftReminders, type AircraftReminder } from '@/lib/adParts'
import { getFleetSummary, type FleetAircraftSummary } from '@/lib/aircraftSharing'
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
const RING_SIZE = 132
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
        <Text style={[styles.ringCenterNum, { color: tokens.t1, fontSize: fs(28) }]}>{total}</Text>
        <Text style={[styles.ringCenterUnit, { color: tokens.t4, fontSize: fs(10) }]}>AIRCRAFT</Text>
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
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [nickname, setNickname] = useState('')
  const [typeDesignator, setTypeDesignator] = useState('')
  const [year, setYear] = useState<number | null>(null)
  const [yearPickerOpen, setYearPickerOpen] = useState(false)
  const typeDesignatorEdited = useRef(false)
  const [saving, setSaving] = useState(false)
  // Accordion, not multi-expand -- RC: "i like the inline expand for the
  // a/c's in Fleet... tap to expand is the top part and we put a small
  // button... at the bottom which takes you into that full a/c page."
  // One aircraft expanded at a time keeps a long fleet list scannable;
  // details are lazy-fetched on first expand and cached per aircraft so
  // re-collapsing/re-expanding the same row doesn't re-fetch.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedDetails, setExpandedDetails] = useState<Record<string, { reminders: AircraftReminder[] } | 'loading'>>({})

  // RC: "we don't need all this extra stuff. keep all things clean." The
  // row's own "N open ADs" chip (below) already says everything the old
  // inline AD list said, just with more clutter -- Manage is where you'd
  // actually go read or act on one. Reminders don't have an equivalent
  // chip for non-overdue items though, so previewing them here is the
  // only place to see them without navigating away -- that one stays.
  const toggleExpand = (aircraftId: string) => {
    if (expandedId === aircraftId) { setExpandedId(null); return }
    setExpandedId(aircraftId)
    if (!expandedDetails[aircraftId]) {
      setExpandedDetails((prev) => ({ ...prev, [aircraftId]: 'loading' }))
      getAircraftReminders(aircraftId)
        .then((reminders) => setExpandedDetails((prev) => ({ ...prev, [aircraftId]: { reminders } })))
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

  const load = () => {
    if (!session) {
      setLoading(false)
      return
    }
    // get_fleet_summary() returns owned AND shared aircraft in one call,
    // each with its own role and real (not invented) alert counts -- see
    // aircraftSharing.ts's own comment on why this replaced a plain
    // user_aircraft select.
    getFleetSummary()
      .then((rows) => {
        setAircraft(rows)
        Promise.all(rows.map((a) => getAircraftReminders(a.aircraftId).catch(() => [] as AircraftReminder[])))
          .then((lists) => {
            let soonest: number | null = null
            for (const list of lists) {
              for (const r of list) {
                const days = daysUntil(r.dueDate)
                if (days >= 0 && (soonest === null || days < soonest)) soonest = days
              }
            }
            setNextDueDays(soonest)
          })
          .catch(() => setNextDueDays(null))
      })
      .catch((e) => console.error('Failed to load fleet summary:', e?.message ?? e))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [session])

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
              body="Save the aircraft you fly or maintain to get alerted when a new or updated Airworthiness Directive applies to them, instead of scanning the full AD list yourself. Premium can also share an aircraft with other Premium accounts as a viewer or editor."
              forceOnce
              iconSize={fs(15)}
            />
          </View>

          {aircraft.length === 0 ? (
            <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(14) }]}>No aircraft saved yet.</Text>
          ) : (
            <>
              {/* Fleet compliance card -- RC's reference image, built fresh
                  rather than reusing the app's existing plain-badge pattern
                  (see FleetRing's own comment for why this is discrete
                  ticks, not an SVG arc). Ring + legend are the same three
                  real, separate aircraft-level buckets (compliant/open/
                  overdue) that always sum to the fleet total; the stat
                  boxes below are ITEM-level sums (openAdCount/
                  overdueReminderCount added across aircraft), which is why
                  their numbers can differ from the legend's. */}
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

              <View style={styles.aircraftSectionLabel}>
                <Text style={[styles.aircraftSectionTitle, { color: tokens.t3, fontSize: fs(11.5) }]}>AIRCRAFT</Text>
                <Text style={[styles.aircraftSectionSort, { color: tokens.t4, fontSize: fs(11) }]}>Sorted by urgency</Text>
              </View>
              <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {sortedAircraft.map((a, i) => {
                  const canEdit = a.role === 'owner' || a.role === 'editor'
                  const isExpanded = expandedId === a.aircraftId
                  const details = expandedDetails[a.aircraftId]
                  const acLabel = a.nickname || `${a.make} ${a.model}`
                  const primaryLabel = a.nickname || `${a.make} ${a.model}`
                  const secondaryLabel = [`${a.make} ${a.model}`, a.typeDesignator].filter(Boolean).join(' · ')
                  const statusColor = a.overdueReminderCount > 0 ? tokens.red : a.openAdCount > 0 ? tokens.amb : tokens.grn
                  const statusText = a.overdueReminderCount > 0
                    ? `Overdue · ${a.overdueReminderCount}`
                    : a.openAdCount > 0
                    ? `Open · ${a.openAdCount}`
                    : 'Compliant'
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
                      <View style={[styles.statusPill, { backgroundColor: statusColor + '26', borderColor: statusColor + '55' }]}>
                        <Text style={[styles.statusPillText, { color: statusColor, fontSize: fs(11.5) }]}>{statusText}</Text>
                      </View>
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
                            <Text style={[styles.expandGroupLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>REMINDERS</Text>
                            {details.reminders.length === 0 ? (
                              <Text style={[styles.expandEmpty, { color: tokens.t3, fontSize: fs(12.5) }]}>None set.</Text>
                            ) : (
                              [...details.reminders]
                                .sort((x, y) => daysUntil(x.dueDate) - daysUntil(y.dueDate))
                                .slice(0, 4)
                                .map((r) => {
                                  const days = daysUntil(r.dueDate)
                                  const overdue = days < 0
                                  return (
                                    <View key={r.id} style={styles.expandRow}>
                                      <Icon name="hourglass" size={fs(12)} color={overdue ? tokens.amb : tokens.t3} />
                                      <Text style={[styles.expandRowTitle, { color: tokens.t1, fontSize: fs(12.5) }]}>{r.title}</Text>
                                      <Text style={[styles.expandRowSub, { color: overdue ? tokens.amb : tokens.t3, fontSize: fs(12) }]}>
                                        {overdue ? `${Math.abs(days)}d overdue` : `${days}d`}
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
            </>
          )}

          {/* No manual "enter invite code" UI -- best part is no part.
              Joining a shared aircraft happens entirely by tapping the
              link an owner shares (join/[token].tsx), same as folders;
              there's nothing left for the receiver to do on this screen. */}
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
            <TypeDesignatorField
              value={typeDesignator}
              onChangeText={handleTypeDesignatorChange}
              onSelectManufacturer={(mfr) => { if (!make.trim()) setMake(mfr) }}
              tokens={tokens}
              fs={fs}
            />
            <Text style={[styles.typeHint, { color: tokens.t3, fontSize: fs(11.5) }]}>
              Model is the marketing name (Skyhawk, Warrior) if it has one — Type designator is the FAA's technical
              code (172S, PA-28-181) that Airworthiness Directives are actually filed under. We auto-suggest a type
              from common model names; some aircraft (e.g. Pilatus PC-12) aren't known by any name besides their
              type — just enter it in both fields.
            </Text>
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
  statusPill: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 4 },
  statusPillText: { fontWeight: '700' },
  // Fleet compliance card -- ring + legend on top, three stat boxes below.
  fleetCard: { borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 16, gap: 14 },
  fleetCardTop: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  ringTickWrap: { alignItems: 'center' },
  ringTick: { width: 5, height: 15, borderRadius: 2.5, marginTop: 4 },
  ringCenter: { alignItems: 'center', justifyContent: 'center' },
  ringCenterNum: { fontWeight: '700' },
  ringCenterUnit: { letterSpacing: 0.8, marginTop: -2, fontWeight: '600' },
  legend: { flex: 1, gap: 10 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot: { width: 9, height: 9, borderRadius: 4.5 },
  legendLabel: { flex: 1 },
  legendCount: { fontWeight: '700' },
  statBoxRow: { flexDirection: 'row', gap: 10 },
  statBox: { flex: 1, borderRadius: 12, borderWidth: 1, paddingVertical: 10, alignItems: 'center', gap: 2 },
  statBoxValue: { fontWeight: '700' },
  statBoxLabel: { letterSpacing: 0.4, fontWeight: '600' },
  aircraftSectionLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 2 },
  aircraftSectionTitle: { fontWeight: '700', letterSpacing: 0.6 },
  aircraftSectionSort: { fontWeight: '500' },
  expandPanel: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 10 },
  expandGroupLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 },
  expandEmpty: { marginBottom: 2 },
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
  // RC, real device (annotated screenshot): this hint text visually
  // crowded into the Type Designator field right above it. Root cause was
  // a literal negative marginTop pulling it up -- the exact opposite of
  // the breathing room this dense a screen needs.
  typeHint: { marginTop: 8, marginBottom: 2 },
  addButton: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  addButtonText: { color: '#fff', fontWeight: '600', fontSize: 14.5 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, gap: 4 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { fontWeight: '700' },
})
