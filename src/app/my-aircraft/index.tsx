import { useEffect, useState, useRef } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert, Modal } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { TabletContainer } from '@/components/TabletContainer'
import { supabase } from '@/lib/supabase'
import {
  suggestTypeDesignator, searchTypeDesignators, searchManufacturers, searchMarketingNames,
  type TypeDesignatorSuggestion,
} from '@/lib/aircraftModels'
import { backfillAircraftAds, getAircraftAdNotifications, markAdNotificationRead, type AircraftAdNotification } from '@/lib/adNotifications'
import { getAircraftReminders, type AircraftReminder } from '@/lib/adParts'
import { getFleetSummary, joinSharedAircraft, type FleetAircraftSummary } from '@/lib/aircraftSharing'
import { SwipeToDelete } from '@/components/SwipeToDelete'

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
interface UserAircraft {
  id: string
  make: string
  model: string
  nickname: string | null
  type_designator: string | null
  year: number | null
}

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

export default function MyAircraftScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro, isPremium } = useAuth()
  const [aircraft, setAircraft] = useState<FleetAircraftSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [nickname, setNickname] = useState('')
  const [typeDesignator, setTypeDesignator] = useState('')
  const [year, setYear] = useState<number | null>(null)
  const [yearPickerOpen, setYearPickerOpen] = useState(false)
  const typeDesignatorEdited = useRef(false)
  const [saving, setSaving] = useState(false)
  const [editingAircraft, setEditingAircraft] = useState<UserAircraft | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [joining, setJoining] = useState(false)
  // Accordion, not multi-expand -- RC: "i like the inline expand for the
  // a/c's in Fleet... tap to expand is the top part and we put a small
  // button... at the bottom which takes you into that full a/c page."
  // One aircraft expanded at a time keeps a long fleet list scannable;
  // details are lazy-fetched on first expand and cached per aircraft so
  // re-collapsing/re-expanding the same row doesn't re-fetch.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedDetails, setExpandedDetails] = useState<Record<string, { ads: AircraftAdNotification[]; reminders: AircraftReminder[] } | 'loading'>>({})

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
      .then((rows) => setAircraft(rows))
      .catch((e) => console.error('Failed to load fleet summary:', e?.message ?? e))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [session])

  const handleJoin = async () => {
    if (!session) {
      router.push('/auth')
      return
    }
    // Sharing is Premium-only for EVERY participant, not just the owner --
    // RC: "anyone who is going to be receiving and viewing Fleet data has
    // to, themselves, have a Prem account." This is a client-side gate,
    // same pattern as every other tier check in this app (the join RPC
    // itself has no subscription check of its own).
    if (!isPremium) {
      Alert.alert(
        'Premium required',
        'Viewing or editing a shared aircraft requires your own Premium subscription.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Upgrade to Premium', onPress: () => router.push('/paywall?tier=premium') },
        ]
      )
      return
    }
    const code = joinCode.trim()
    if (!code) return
    setJoining(true)
    try {
      const joined = await joinSharedAircraft(code)
      setJoinCode('')
      load()
      Alert.alert('Joined', `${joined.nickname || `${joined.make} ${joined.model}`} now appears in your Fleet as ${joined.role}.`)
    } catch (e: any) {
      Alert.alert('Could not join', e?.message ?? 'Unknown error')
    }
    setJoining(false)
  }

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
              {/* Total aircraft count and alert counts are two DIFFERENT
                  numbers, shown as visibly separate pieces -- RC, on the
                  mockup: "now it looks like 2 a/c are overdue, but open and
                  find that of the two inside, only 1 is overdue. so you
                  need an a/c total and also a 'status' chip for the
                  alerts." Built from get_fleet_summary()'s two genuinely
                  real, separate facts (open AD count, overdue reminder
                  count) -- never one conflated "overdue" number. */}
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryTotal, { color: tokens.t1, fontSize: fs(13.5) }]}>
                  {aircraft.length} aircraft
                </Text>
                {totalOverdue > 0 && (
                  <View style={[styles.summaryChip, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}>
                    <Icon name="hourglass" size={fs(11)} color={tokens.amb} />
                    <Text style={[styles.summaryChipText, { color: tokens.amb, fontSize: fs(11.5) }]}>
                      {totalOverdue} reminder{totalOverdue === 1 ? '' : 's'} overdue
                    </Text>
                  </View>
                )}
                {totalOpenAds > 0 && (
                  <View style={[styles.summaryChip, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}>
                    <Icon name="wrench" size={fs(11)} color={tokens.t2} />
                    <Text style={[styles.summaryChipText, { color: tokens.t2, fontSize: fs(11.5) }]}>
                      {totalOpenAds} open AD{totalOpenAds === 1 ? '' : 's'}
                    </Text>
                  </View>
                )}
              </View>
              <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {aircraft.map((a, i) => {
                  const canEdit = a.role === 'owner' || a.role === 'editor'
                  const isExpanded = expandedId === a.aircraftId
                  const details = expandedDetails[a.aircraftId]
                  const acLabel = a.nickname || `${a.make} ${a.model}`
                  return (
                  <View
                    key={a.aircraftId}
                    style={i < aircraft.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }}
                  >
                    <SwipeToDelete
                      onDelete={() => handleRemove(a)}
                      onPress={() => toggleExpand(a.aircraftId)}
                      disabled={a.role !== 'owner'}
                    >
                    <View style={[styles.row, { backgroundColor: tokens.bg2 }]}>
                      <View style={{ flex: 1 }}>
                        <View style={styles.rowMakeLine}>
                          <Text style={[styles.rowMake, { color: tokens.t1, fontSize: fs(14.5) }]}>
                            {a.year ? `${a.year} ` : ''}{a.make} {a.model}
                          </Text>
                          {a.role !== 'owner' && (
                            <View style={[styles.roleBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}>
                              <Text style={[styles.roleBadgeText, { color: tokens.t3, fontSize: fs(10) }]}>
                                {a.role === 'editor' ? 'EDITOR' : 'VIEWER'}
                              </Text>
                            </View>
                          )}
                        </View>
                        {(a.nickname || a.typeDesignator) && (
                          <Text style={[styles.rowNickname, { color: tokens.t3, fontSize: fs(12.5) }]}>
                            {[a.nickname, a.typeDesignator ? `Type ${a.typeDesignator}` : null].filter(Boolean).join(' · ')}
                          </Text>
                        )}
                        {(a.openAdCount > 0 || a.overdueReminderCount > 0) && (
                          <View style={styles.rowChips}>
                            {a.overdueReminderCount > 0 && (
                              <View style={[styles.alertChip, { backgroundColor: tokens.bdim }]}>
                                <Icon name="hourglass" size={fs(10)} color={tokens.amb} />
                                <Text style={[styles.alertChipText, { color: tokens.amb, fontSize: fs(11) }]}>
                                  {a.overdueReminderCount} overdue
                                </Text>
                              </View>
                            )}
                            {a.openAdCount > 0 && (
                              <View style={[styles.alertChip, { backgroundColor: tokens.bdim }]}>
                                <Icon name="wrench" size={fs(10)} color={tokens.t3} />
                                <Text style={[styles.alertChipText, { color: tokens.t3, fontSize: fs(11) }]}>
                                  {a.openAdCount} open AD{a.openAdCount === 1 ? '' : 's'}
                                </Text>
                              </View>
                            )}
                          </View>
                        )}
                      </View>
                      {canEdit && (
                        <Pressable
                          onPress={(e) => {
                            e.stopPropagation()
                            setEditingAircraft({
                              id: a.aircraftId, make: a.make, model: a.model,
                              nickname: a.nickname, type_designator: a.typeDesignator, year: a.year,
                            })
                          }}
                          hitSlop={10}
                          style={{ marginRight: 14 }}
                        >
                          <Icon name="pencil" size={fs(17)} color={tokens.t3} />
                        </Pressable>
                      )}
                      <Icon name={isExpanded ? 'chevron.down' : 'chevron.right'} size={fs(14)} color={tokens.t4} />
                    </View>
                    </SwipeToDelete>

                    {isExpanded && (
                      <View style={[styles.expandPanel, { borderTopColor: tokens.bdr }]}>
                        {!details || details === 'loading' ? (
                          <ActivityIndicator color={tokens.blu} style={{ marginVertical: 10 }} />
                        ) : (
                          <>
                            <Text style={[styles.expandGroupLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>APPLICABLE ADs</Text>
                            {details.ads.length === 0 ? (
                              <Text style={[styles.expandEmpty, { color: tokens.t3, fontSize: fs(12.5) }]}>No open ADs.</Text>
                            ) : (
                              details.ads.slice(0, 4).map((n) => (
                                <Pressable
                                  key={n.id}
                                  style={styles.expandRow}
                                  onPress={() => {
                                    if (!n.readAt) {
                                      const nowIso = new Date().toISOString()
                                      setExpandedDetails((prev) => {
                                        const cur = prev[a.aircraftId]
                                        if (!cur || cur === 'loading') return prev
                                        return { ...prev, [a.aircraftId]: { ...cur, ads: cur.ads.map((x) => (x.id === n.id ? { ...x, readAt: nowIso } : x)) } }
                                      })
                                      markAdNotificationRead(n.id).catch((e) => console.error('Failed to mark AD notification read:', e?.message ?? e))
                                    }
                                    router.push(`/ad/${n.adNumber}` as any)
                                  }}
                                >
                                  {!n.readAt && <View style={[styles.unreadDot, { backgroundColor: tokens.blu }]} />}
                                  <Text style={[styles.expandRowTitle, { color: tokens.blu, fontSize: fs(12.5) }]}>AD {n.adNumber}</Text>
                                  <Text style={[styles.expandRowSub, { color: tokens.t2, fontSize: fs(12) }]} numberOfLines={1}>{n.subjectHeading}</Text>
                                </Pressable>
                              ))
                            )}
                            {details.ads.length > 4 && (
                              <Text style={[styles.expandMore, { color: tokens.t3, fontSize: fs(11.5) }]}>+{details.ads.length - 4} more</Text>
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

          {isPremium && (
            <>
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), marginTop: aircraft.length === 0 ? 0 : 20 }]}>
                JOIN SHARED AIRCRAFT
              </Text>
              <View style={[styles.formCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, flexDirection: 'row', gap: 8 }]}>
                <TextInput
                  value={joinCode}
                  onChangeText={setJoinCode}
                  placeholder="Enter invite code"
                  placeholderTextColor={tokens.t3}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={[styles.input, { flex: 1, color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }]}
                />
                <Pressable
                  style={[styles.addButton, { backgroundColor: tokens.blu, marginTop: 0, paddingHorizontal: 18 }]}
                  onPress={handleJoin}
                  disabled={joining || !joinCode.trim()}
                >
                  {joining ? <ActivityIndicator color="#fff" size="small" /> : <Text style={[styles.addButtonText, { fontSize: fs(14.5) }]}>Join</Text>}
                </Pressable>
              </View>
            </>
          )}

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

      <EditAircraftModal
        aircraft={editingAircraft}
        onClose={() => setEditingAircraft(null)}
        onSaved={() => { setEditingAircraft(null); load() }}
      />
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

function EditAircraftModal({ aircraft, onClose, onSaved }: { aircraft: UserAircraft | null; onClose: () => void; onSaved: () => void }) {
  const { tokens } = useTheme()
  const fs = useFS()
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [typeDesignator, setTypeDesignator] = useState('')
  const [nickname, setNickname] = useState('')
  const [year, setYear] = useState<number | null>(null)
  const [yearPickerOpen, setYearPickerOpen] = useState(false)
  const typeDesignatorEdited = useRef(false)
  const [saving, setSaving] = useState(false)

  // Re-seed the form every time a different aircraft is opened for edit --
  // the modal component itself stays mounted (visible toggles), so state
  // wouldn't otherwise reset between edits of two different aircraft.
  useEffect(() => {
    if (!aircraft) return
    setMake(aircraft.make)
    setModel(aircraft.model)
    // Aircraft saved before this field existed have no stored
    // type_designator -- suggest one now from the bridge instead of
    // showing a blank field the user has to know to re-type the model
    // into (confirmed live: editing an existing "Lake buccaneer" left the
    // field empty rather than surfacing the LA-4 suggestion it should).
    setTypeDesignator(aircraft.type_designator ?? suggestTypeDesignator(aircraft.model) ?? '')
    setNickname(aircraft.nickname ?? '')
    setYear(aircraft.year ?? null)
    typeDesignatorEdited.current = !!aircraft.type_designator
  }, [aircraft])

  const handleModelChange = (text: string) => {
    setModel(text)
    if (!typeDesignatorEdited.current) setTypeDesignator(suggestTypeDesignator(text) ?? '')
  }

  const handleTypeDesignatorChange = (text: string) => {
    typeDesignatorEdited.current = true
    setTypeDesignator(text)
  }

  const handleSave = async () => {
    if (!aircraft) return
    const trimmedMake = make.trim()
    const trimmedType = typeDesignator.trim()
    const trimmedModel = model.trim() || trimmedType
    if (!trimmedMake || !trimmedModel) {
      Alert.alert('Make and model required', 'Enter both the aircraft make and model.')
      return
    }
    if (!trimmedType) {
      Alert.alert('Type designator required', 'Enter the FAA type designator (e.g. PA-28-181, 172S) so we can match Airworthiness Directives correctly.')
      return
    }
    setSaving(true)
    const { error } = await supabase
      .from('user_aircraft')
      .update({
        make: trimmedMake, model: trimmedModel,
        type_designator: trimmedType, nickname: nickname.trim() || null,
        year,
      })
      .eq('id', aircraft.id)
    setSaving(false)
    if (error) {
      Alert.alert('Could not save changes', error.message)
      return
    }
    onSaved()
  }

  return (
    <Modal visible={!!aircraft} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>Edit Aircraft</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Icon name="xmark" size={fs(18)} color={tokens.t3} />
            </Pressable>
          </View>
          <MakeField value={make} onChangeText={setMake} tokens={tokens} fs={fs} style={{ marginTop: 12 }} />
          <ModelField
            value={model}
            onChangeText={handleModelChange}
            onSelectDesignator={(d) => { if (!typeDesignatorEdited.current) setTypeDesignator(d) }}
            tokens={tokens}
            fs={fs}
            style={{ marginTop: 10 }}
          />
          <TypeDesignatorField
            value={typeDesignator}
            onChangeText={handleTypeDesignatorChange}
            onSelectManufacturer={(mfr) => { if (!make.trim()) setMake(mfr) }}
            tokens={tokens}
            fs={fs}
            style={{ marginTop: 10 }}
          />
          <Text style={[styles.typeHint, { color: tokens.t3, fontSize: fs(11.5), marginTop: 6 }]}>
            Model is the marketing name (Skyhawk, Warrior) — Type designator is the FAA code (172S, PA-28-181) ADs
            are filed under. No marketing name? Enter the type in both fields.
          </Text>
          <YearField value={year} onPress={() => setYearPickerOpen(true)} tokens={tokens} fs={fs} style={{ marginTop: 10 }} />
          <TextInput
            value={nickname}
            onChangeText={setNickname}
            placeholder="Nickname (optional, e.g. N12345)"
            placeholderTextColor={tokens.t3}
            style={[styles.input, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr, marginTop: 10 }]}
          />
          <Pressable style={[styles.addButton, { backgroundColor: tokens.blu, marginTop: 14 }]} onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={[styles.addButtonText, { fontSize: fs(14.5) }]}>Save Changes</Text>}
          </Pressable>
        </View>
      </View>
      <YearPickerModal
        visible={yearPickerOpen}
        initialYear={year}
        onClose={() => setYearPickerOpen(false)}
        onSelect={setYear}
        tokens={tokens}
        fs={fs}
      />
    </Modal>
  )
}

// Typeahead against the real FAA registry catalog (task #12, backed by
// #11's aircraft_type_designators table -- 9,229 real Type-Certificated
// designators, not a guess). Debounced so every keystroke doesn't fire a
// query; shows up to 8 "MANUFACTURER — DESIGNATOR" matches, tapping one
// fills the designator field and, if make is still blank, the manufacturer
// too. Shared between the inline Add form and EditAircraftModal below --
// same field, same behavior, no reason to diverge.
function TypeDesignatorField({
  value, onChangeText, onSelectManufacturer, tokens, fs, style,
}: {
  value: string
  onChangeText: (text: string) => void
  onSelectManufacturer?: (mfr: string) => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  style?: object
}) {
  const [suggestions, setSuggestions] = useState<TypeDesignatorSuggestion[]>([])
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused || value.trim().length < 2) { setSuggestions([]); return }
    let live = true
    const t = setTimeout(() => {
      searchTypeDesignators(value).then((rows) => { if (live) setSuggestions(rows) })
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [value, focused])

  const handleSelect = (s: TypeDesignatorSuggestion) => {
    onChangeText(s.type_designator)
    onSelectManufacturer?.(s.manufacturer)
    setSuggestions([])
    setFocused(false)
  }

  return (
    <View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        // Deferred so a suggestion tap's own touch event lands before the
        // list unmounts -- an immediate onBlur hide would swallow the tap.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="Type designator (required, e.g. PA-28-181)"
        placeholderTextColor={tokens.t3}
        autoCapitalize="characters"
        style={[styles.input, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }, style]}
      />
      {focused && suggestions.length > 0 && (
        <View style={[styles.suggestBox, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          {suggestions.map((s, i) => (
            <Pressable
              key={`${s.manufacturer}-${s.type_designator}`}
              style={[styles.suggestRow, i < suggestions.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}
              onPress={() => handleSelect(s)}
            >
              <Text style={{ color: tokens.t1, fontSize: fs(13.5) }}>
                <Text style={{ fontWeight: '600' }}>{s.type_designator}</Text>
                <Text style={{ color: tokens.t3 }}> — {s.manufacturer}</Text>
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

// Make field typeahead ("C" -> Cessna, Cirrus, ...) -- see
// aircraftModels.ts's searchManufacturers for the subsequence-match +
// dedup logic. Same debounce/dropdown shape as TypeDesignatorField above,
// but simple string suggestions rather than a two-part label.
function MakeField({
  value, onChangeText, tokens, fs, style,
}: {
  value: string
  onChangeText: (text: string) => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  style?: object
}) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused || value.trim().length < 1) { setSuggestions([]); return }
    let live = true
    const t = setTimeout(() => {
      searchManufacturers(value).then((rows) => { if (live) setSuggestions(rows) })
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [value, focused])

  const handleSelect = (name: string) => {
    onChangeText(name)
    setSuggestions([])
    setFocused(false)
  }

  return (
    <View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="Make (e.g. Cessna)"
        placeholderTextColor={tokens.t3}
        style={[styles.input, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }, style]}
      />
      {focused && suggestions.length > 0 && (
        <View style={[styles.suggestBox, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          {suggestions.map((name, i) => (
            <Pressable
              key={name}
              style={[styles.suggestRow, i < suggestions.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}
              onPress={() => handleSelect(name)}
            >
              <Text style={{ color: tokens.t1, fontSize: fs(13.5) }}>{name}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

// Model field typeahead -- but for MARKETING names, not the technical
// designator MakeField's sibling above searches ("S" -> Skyhawk, Saratoga,
// ...). Backed by the small curated AIRCRAFT_MODEL_ALIASES bridge (a
// synchronous, client-side filter -- there's no DB table of marketing
// names, see searchMarketingNames's own comment). Selecting a suggestion
// also offers its known type designator via onSelectDesignator, same
// auto-suggest behavior typing the full name out would have triggered.
function ModelField({
  value, onChangeText, onSelectDesignator, tokens, fs, style,
}: {
  value: string
  onChangeText: (text: string) => void
  onSelectDesignator?: (designator: string) => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  style?: object
}) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused || value.trim().length < 1) { setSuggestions([]); return }
    setSuggestions(searchMarketingNames(value))
  }, [value, focused])

  const handleSelect = (name: string) => {
    onChangeText(name)
    const designator = suggestTypeDesignator(name)
    if (designator) onSelectDesignator?.(designator)
    setSuggestions([])
    setFocused(false)
  }

  return (
    <View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="Model name (e.g. Skyhawk) — leave blank if none"
        placeholderTextColor={tokens.t3}
        style={[styles.input, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }, style]}
      />
      {focused && suggestions.length > 0 && (
        <View style={[styles.suggestBox, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          {suggestions.map((name, i) => (
            <Pressable
              key={name}
              style={[styles.suggestRow, i < suggestions.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}
              onPress={() => handleSelect(name)}
            >
              <Text style={{ color: tokens.t1, fontSize: fs(13.5) }}>{name}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

// A plain pressable field (not a TextInput) that opens YearPickerModal --
// year is a picked value, never freehand-typed, so this deliberately
// looks and behaves like every other "opens a picker" row in the app
// rather than a text field with a fake disabled cursor.
function YearField({
  value, onPress, tokens, fs, style,
}: {
  value: number | null
  onPress: () => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  style?: object
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.input, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderColor: tokens.bdr }, style]}
    >
      <Text style={{ color: value ? tokens.t1 : tokens.t3, fontSize: fs(14.5) }}>
        {value ?? 'Year (optional)'}
      </Text>
      <Icon name="chevron.down" size={fs(14)} color={tokens.t4} />
    </Pressable>
  )
}

const YEAR_ROW_HEIGHT = 40
const YEAR_VISIBLE_ROWS = 5
const CURRENT_YEAR = new Date().getFullYear()
// Descending, starting two years ahead of today so a brand-new model-year
// purchase (aircraft are commonly sold under next year's or the year
// after's model year late in the current calendar year, same as cars) is
// reachable without scrolling past "today." CURRENT_YEAR is computed above
// from the real system clock at module load, so this bound always tracks
// the actual current year rather than a hardcoded number. 1930 floor
// comfortably covers any airworthy certificated GA aircraft still flying.
const YEARS = Array.from({ length: CURRENT_YEAR - 1930 + 3 }, (_, i) => CURRENT_YEAR + 2 - i)

// A real scroll-wheel picker (RC: "maybe we give users a popup scroll
// wheel to select the year") built from plain ScrollView snap-scrolling --
// no native picker dependency (none is installed, and adding one needs a
// new native build this web-preview session can't verify) -- `
// snapToInterval` + `decelerationRate="fast"` + `onMomentumScrollEnd` is
// the standard RN pattern for this, and all three work on RN Web too.
function YearPickerModal({
  visible, initialYear, onClose, onSelect, tokens, fs,
}: {
  visible: boolean
  initialYear: number | null
  onClose: () => void
  onSelect: (year: number) => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
}) {
  const scrollRef = useRef<ScrollView>(null)
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pending, setPending] = useState(initialYear ?? CURRENT_YEAR)

  useEffect(() => {
    if (!visible) return
    setPending(initialYear ?? CURRENT_YEAR)
    const idx = Math.max(0, YEARS.indexOf(initialYear ?? CURRENT_YEAR))
    // Modal mount + ScrollView layout both need a tick before scrollTo
    // lands correctly -- confirmed live, an immediate call was a no-op.
    const t = setTimeout(() => scrollRef.current?.scrollTo({ y: idx * YEAR_ROW_HEIGHT, animated: false }), 50)
    return () => clearTimeout(t)
  }, [visible, initialYear])

  const updatePendingFromOffset = (offsetY: number) => {
    const idx = Math.round(offsetY / YEAR_ROW_HEIGHT)
    const clamped = Math.max(0, Math.min(YEARS.length - 1, idx))
    setPending(YEARS[clamped])
  }

  const handleMomentumEnd = (e: any) => updatePendingFromOffset(e.nativeEvent.contentOffset.y)

  // `onMomentumScrollEnd` only fires after TOUCH-driven momentum, which a
  // mouse-wheel/trackpad scroll (this app also ships a web build) never
  // produces -- confirmed live: wheel-scrolling this picker moved the
  // highlighted row but never updated the actual selection. This is the
  // web-input fallback: every plain scroll event resets a short "has this
  // settled" timer, so the same offset->year math runs once scrolling
  // actually stops, regardless of what produced the scroll.
  const handleScroll = (e: any) => {
    const offsetY = e.nativeEvent.contentOffset.y
    if (settleRef.current) clearTimeout(settleRef.current)
    settleRef.current = setTimeout(() => updatePendingFromOffset(offsetY), 120)
  }

  const wheelHeight = YEAR_ROW_HEIGHT * YEAR_VISIBLE_ROWS

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          <View style={styles.modalHeader}>
            <Pressable onPress={onClose} hitSlop={10}><Text style={{ color: tokens.t3, fontSize: fs(14.5) }}>Cancel</Text></Pressable>
            <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>Year</Text>
            <Pressable onPress={() => { onSelect(pending); onClose() }} hitSlop={10}>
              <Text style={{ color: tokens.blu, fontWeight: '700', fontSize: fs(14.5) }}>Done</Text>
            </Pressable>
          </View>
          <View style={{ height: wheelHeight, marginTop: 4 }}>
            <View
              pointerEvents="none"
              style={{
                position: 'absolute', left: 0, right: 0,
                top: YEAR_ROW_HEIGHT * Math.floor(YEAR_VISIBLE_ROWS / 2), height: YEAR_ROW_HEIGHT,
                borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth,
                borderColor: tokens.bdr, backgroundColor: tokens.bdim,
              }}
            />
            <ScrollView
              ref={scrollRef}
              showsVerticalScrollIndicator={false}
              snapToInterval={YEAR_ROW_HEIGHT}
              decelerationRate="fast"
              onMomentumScrollEnd={handleMomentumEnd}
              onScroll={handleScroll}
              scrollEventThrottle={32}
              contentContainerStyle={{ paddingVertical: YEAR_ROW_HEIGHT * Math.floor(YEAR_VISIBLE_ROWS / 2) }}
            >
              {YEARS.map((y) => (
                <Pressable
                  key={y}
                  style={{ height: YEAR_ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' }}
                  onPress={() => {
                    setPending(y)
                    scrollRef.current?.scrollTo({ y: YEARS.indexOf(y) * YEAR_ROW_HEIGHT, animated: true })
                  }}
                >
                  <Text style={{ color: y === pending ? tokens.t1 : tokens.t3, fontWeight: y === pending ? '700' : '400', fontSize: fs(y === pending ? 17 : 14.5) }}>
                    {y}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </View>
    </Modal>
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
  row: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  rowMakeLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  rowMake: { fontWeight: '600' },
  rowNickname: { marginTop: 2 },
  rowChips: { flexDirection: 'row', gap: 6, marginTop: 6 },
  alertChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  alertChipText: { fontWeight: '600' },
  roleBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  roleBadgeText: { fontWeight: '700', letterSpacing: 0.4 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  summaryTotal: { fontWeight: '600' },
  summaryChip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 12, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 4 },
  summaryChipText: { fontWeight: '600' },
  expandPanel: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 10 },
  expandGroupLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 },
  expandEmpty: { marginBottom: 2 },
  expandRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  expandRowTitle: { fontWeight: '600' },
  expandRowSub: { flex: 1 },
  expandMore: { marginTop: 2 },
  unreadDot: { width: 6, height: 6, borderRadius: 3 },
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
