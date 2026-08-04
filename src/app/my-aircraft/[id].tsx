import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, ActivityIndicator, Alert, Modal, Share } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { TabletContainer } from '@/components/TabletContainer'
import { SwipeToDelete } from '@/components/SwipeToDelete'
import { supabase } from '@/lib/supabase'
import {
  searchParts, getAircraftEquipment, addAircraftEquipment, removeAircraftEquipment,
  getAircraftReminders, addAircraftReminder, updateAircraftReminder, removeAircraftReminder, PART_TYPE_LABELS,
  type AdPart, type AircraftEquipment, type AircraftReminder, type PartComponentType,
} from '@/lib/adParts'
import { getAircraftAdNotifications, markAdNotificationRead, dismissAdNotification, backfillAircraftAds, type AircraftAdNotification } from '@/lib/adNotifications'
import {
  getMyAircraftRole, getOrCreateShareCode, getAircraftCollaborators, removeCollaborator, leaveSharedAircraft,
  type CollaboratorRole, type AircraftCollaborator, type FleetRole,
} from '@/lib/aircraftSharing'

// Equipment tags + reminders are both Premium (personalized-tracking
// depth on top of the free/Pro basics) -- see flyregs_decisions.md's AD
// Compliance-Tracking Scope Decision. Everything here is either (a) a
// suggestion off a part the user themselves tagged, or (b) a date the
// user themselves entered -- the app verifies none of it independently,
// which is what keeps this low-liability regardless of depth. "May
// apply" / "reminder", never "applies" / "is due" as a fact.

interface UserAircraft {
  id: string
  make: string
  model: string
  nickname: string | null
  type_designator: string | null
}

function daysUntil(dateStr: string): number {
  const due = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - now.getTime()) / 86400000)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from)
  d.setMonth(d.getMonth() + months)
  return d
}

// Quick-select reminder types with hardcoded recurrence defaults -- RC:
// "which schema is more flexible and easy to use for the user? if the
// gating is better and more accurate and more hands off for the user,
// that's good. but they should still be able to manually adjust a date if
// needed to match their exact needs." No schema change: `months` here only
// pre-fills a SUGGESTED due date at creation time (today + N months) via
// DatePickerModal, which the user can still scroll to any date they want
// before saving -- nothing about the interval is enforced or re-applied
// later. 100-Hour is genuinely hobbs/tach-based, not calendar-based, so it
// gets no smart default (`months: null`) -- a suggested date would just be
// wrong. AD Compliance also gets no calendar default since compliance
// intervals vary per AD and aren't modeled in this schema; picking that
// type instead reveals the AD-link picker below.
const REMINDER_TYPES = [
  { key: 'annual', label: 'Annual', icon: 'checkmark.seal.fill', defaultTitle: 'Annual Inspection', months: 12 },
  { key: 'transponder', label: 'Transponder', icon: 'dot.radiowaves.left.and.right', defaultTitle: 'Transponder Check', months: 24 },
  { key: 'elt', label: 'ELT Battery', icon: 'bolt.fill', defaultTitle: 'ELT Battery', months: 24 },
  { key: '100hour', label: '100-Hour', icon: 'gauge', defaultTitle: '100-Hour Inspection', months: null },
  { key: 'ad', label: 'AD Compliance', icon: 'wrench.and.screwdriver.fill', defaultTitle: 'AD Compliance', months: null },
  { key: 'custom', label: 'Custom', icon: 'pencil', defaultTitle: '', months: null },
] as const
type ReminderTypeKey = (typeof REMINDER_TYPES)[number]['key']

// "how far back" view filter for Applicable ADs -- RC: "populate that a/c
// profile with them... allowing them to choose how far back they want ADs
// for." Client-side only (the backfill itself always pulls the FULL
// corpus, see adNotifications.ts) -- this just narrows what's shown, so
// widening the range later never needs a re-fetch.
type AdRangeFilter = 'all' | '10y' | '5y' | '2y'
const AD_RANGE_LABELS: Record<AdRangeFilter, string> = { all: 'All time', '10y': '10 yrs', '5y': '5 yrs', '2y': '2 yrs' }
function withinAdRange(citationPublishDate: string | null, range: AdRangeFilter): boolean {
  if (range === 'all' || !citationPublishDate) return true
  const years = range === '10y' ? 10 : range === '5y' ? 5 : 2
  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - years)
  return new Date(citationPublishDate) >= cutoff
}

export default function AircraftDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPremium } = useAuth()
  const [aircraft, setAircraft] = useState<UserAircraft | null>(null)
  const [adNotifications, setAdNotifications] = useState<AircraftAdNotification[]>([])
  const [adRange, setAdRange] = useState<AdRangeFilter>('all')
  const [backfilling, setBackfilling] = useState(false)
  const [equipment, setEquipment] = useState<AircraftEquipment[]>([])
  const [reminders, setReminders] = useState<AircraftReminder[]>([])
  const [loading, setLoading] = useState(true)
  const [partPickerVisible, setPartPickerVisible] = useState(false)
  const [reminderFormVisible, setReminderFormVisible] = useState(false)
  const [editingReminder, setEditingReminder] = useState<AircraftReminder | null>(null)
  // Per-section collapse -- RC, live, on the Applicable ADs list routinely
  // running 60+ rows deep: "we need an expand/collapse button for the AD,
  // Parts, and Reminders sections so the user doesn't have to scroll past
  // long lists to get to another section." All three default open
  // (unchanged behavior) -- the toggle just gives an escape hatch that's
  // reachable from the section header itself, so collapsing a long list
  // doesn't require scrolling through it first.
  const [adsCollapsed, setAdsCollapsed] = useState(false)
  const [equipmentCollapsed, setEquipmentCollapsed] = useState(false)
  const [remindersCollapsed, setRemindersCollapsed] = useState(false)
  // 'owner' isn't a real aircraft_collaborators row -- it's what
  // getMyAircraftRole resolving to null means, given RLS already
  // guarantees only the owner or an active collaborator can ever reach
  // this screen at all (see aircraftSharing.ts's own comment).
  const [role, setRole] = useState<FleetRole | null>(null)
  const [collaborators, setCollaborators] = useState<AircraftCollaborator[]>([])
  const [sharingBusy, setSharingBusy] = useState(false)

  const load = useCallback(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      supabase.from('user_aircraft').select('id, make, model, nickname, type_designator').eq('id', id).single(),
      getAircraftAdNotifications(id),
      getAircraftEquipment(id),
      getAircraftReminders(id),
      getMyAircraftRole(id).catch(() => null),
    ]).then(([acRes, ads, equip, rem, myRole]) => {
      if (acRes.data) setAircraft(acRes.data as UserAircraft)
      setAdNotifications(ads)
      setEquipment(equip)
      setReminders(rem)
      const resolvedRole: FleetRole = myRole ?? 'owner'
      setRole(resolvedRole)
      setLoading(false)
      // Collaborator roster management is owner-only -- get_aircraft_
      // collaborators raises for anyone else, matching join_shared_
      // folder's existing precedent of scoping the roster call itself,
      // not just hiding the UI for it.
      if (resolvedRole === 'owner') {
        getAircraftCollaborators(id).then(setCollaborators).catch(() => setCollaborators([]))
      }
    })
  }, [id])

  useEffect(() => { load() }, [load])

  const isOwner = role === 'owner'
  const canEdit = role === 'owner' || role === 'editor'

  const handleShare = () => {
    if (!aircraft) return
    Alert.alert(
      'Share this aircraft',
      "Choose what the person you invite can do. They'll need their own Premium subscription to join.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Invite as Viewer', onPress: () => shareAs('viewer') },
        { text: 'Invite as Editor', onPress: () => shareAs('editor') },
      ]
    )
  }

  const shareAs = async (shareRole: CollaboratorRole) => {
    if (!aircraft) return
    setSharingBusy(true)
    try {
      const code = await getOrCreateShareCode(aircraft.id, shareRole)
      const label = aircraft.nickname || `${aircraft.make} ${aircraft.model}`
      await Share.share({
        message: `Join "${label}" on FlyRegs — open My Fleet, tap Join Shared Aircraft, and enter code ${code}. Requires your own Premium subscription.`,
      })
      getAircraftCollaborators(aircraft.id).then(setCollaborators).catch(() => {})
    } catch (e: any) {
      Alert.alert('Could not create invite', e?.message ?? 'Unknown error')
    }
    setSharingBusy(false)
  }

  const handleRemoveCollaborator = (c: AircraftCollaborator) => {
    if (!aircraft) return
    Alert.alert('Remove Access', `Remove ${c.displayLabel} from this aircraft?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removeCollaborator(aircraft.id, c.userId)
          setCollaborators((prev) => prev.filter((x) => x.userId !== c.userId))
        },
      },
    ])
  }

  const handleLeave = () => {
    if (!aircraft) return
    const label = aircraft.nickname || `${aircraft.make} ${aircraft.model}`
    Alert.alert('Leave Shared Aircraft', `You'll lose access to ${label} until invited again.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          await leaveSharedAircraft(aircraft.id)
          router.back()
        },
      },
    ])
  }

  const visibleAdNotifications = useMemo(
    () => adNotifications.filter((n) => withinAdRange(n.citationPublishDate, adRange)),
    [adNotifications, adRange]
  )
  const handleOpenAd = (n: AircraftAdNotification) => {
    if (!n.readAt) {
      // Optimistic -- the whole point of the unread dot is that it clears
      // the moment the user actually looks at it, not after a round trip.
      setAdNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)))
      markAdNotificationRead(n.id).catch((e) => console.error('Failed to mark AD notification read:', e?.message ?? e))
    }
    router.push(`/ad/${n.adNumber}` as any)
  }

  const handleBackfillAds = async () => {
    if (!aircraft) return
    setBackfilling(true)
    try {
      const count = await backfillAircraftAds(aircraft.id)
      const ads = await getAircraftAdNotifications(aircraft.id)
      setAdNotifications(ads)
      Alert.alert(
        count > 0 ? 'Applicable ADs updated' : 'Up to date',
        count > 0 ? `Found ${count} more Airworthiness Directive${count === 1 ? '' : 's'}.` : 'No additional applicable ADs found.'
      )
    } catch (e: any) {
      Alert.alert('Could not check for ADs', e?.message ?? 'Unknown error')
    }
    setBackfilling(false)
  }

  // Two-step confirm, unlike Equipment/Reminders' single-tap trash -- RC:
  // "we can keep the trash consistent, but need CTA confirmations for two
  // step delete process." A dismissed AD is meaningfully harder to undo
  // than re-adding a part or reminder (see migrations_ad_dismiss.sql: it
  // stays dismissed across future syncs, not just removed from this
  // screen), so it gets the extra guard equipment/reminders don't need.
  const handleDismissAd = (n: AircraftAdNotification) => {
    Alert.alert(
      `Remove AD ${n.adNumber}?`,
      "This removes it from this aircraft's list. It won't come back on future AD syncs unless you add it again yourself.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setAdNotifications((prev) => prev.filter((x) => x.id !== n.id))
            try {
              await dismissAdNotification(n.id)
            } catch (e: any) {
              setAdNotifications((prev) => [...prev, n]) // roll back on failure
              Alert.alert('Could not remove AD', e?.message ?? 'Unknown error')
            }
          },
        },
      ]
    )
  }

  // RC: swipe-to-delete "with two step CTA popup verification explaining
  // what will be deleted" -- neither of these had any confirm at all
  // before (a direct trash tap deleted immediately), which is a bigger
  // gap once the action is swipe-triggered, not a deliberate tap.
  const handleRemoveEquipment = (e: AircraftEquipment) => {
    Alert.alert(`Remove ${e.part.name}?`, 'This untags the part from this aircraft -- AD alerts matched only by this equipment will stop appearing.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removeAircraftEquipment(e.id)
          setEquipment((prev) => prev.filter((x) => x.id !== e.id))
        },
      },
    ])
  }

  const handleRemoveReminder = (r: AircraftReminder) => {
    Alert.alert(`Delete "${r.title}"?`, 'This reminder will be permanently removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await removeAircraftReminder(r.id)
          setReminders((prev) => prev.filter((x) => x.id !== r.id))
        },
      },
    ])
  }

  const openAddEquipment = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    setPartPickerVisible(true)
  }

  const openAddReminder = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    setEditingReminder(null)
    setReminderFormVisible(true)
  }

  const openEditReminder = (r: AircraftReminder) => {
    setEditingReminder(r)
    setReminderFormVisible(true)
  }

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Aircraft" onBack={() => router.back()} />
        <View style={styles.center}><ActivityIndicator color={tokens.blu} /></View>
      </View>
    )
  }

  if (!aircraft) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Aircraft" onBack={() => router.back()} />
        <View style={styles.center}>
          <Text style={{ color: tokens.t3, fontSize: fs(14) }}>Aircraft not found.</Text>
        </View>
      </View>
    )
  }

  const shareHeaderAction = isOwner ? (
    <Pressable onPress={handleShare} hitSlop={10} disabled={sharingBusy} style={{ padding: 6 }}>
      <Icon name="person.2.fill" size={fs(21)} color={tokens.t2} />
    </Pressable>
  ) : undefined

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        title={aircraft.nickname || `${aircraft.make} ${aircraft.model}`}
        onBack={() => router.back()}
        right={shareHeaderAction}
      />
      <TabletContainer>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.acLineRow}>
            <Text style={[styles.acLine, { color: tokens.t1, fontSize: fs(17) }]}>{aircraft.make} {aircraft.model}</Text>
            {!isOwner && role && (
              <View style={[styles.roleBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}>
                <Text style={[styles.roleBadgeText, { color: tokens.t3, fontSize: fs(10) }]}>{role.toUpperCase()}</Text>
              </View>
            )}
          </View>
          {aircraft.nickname && <Text style={[styles.acSub, { color: tokens.t3, fontSize: fs(13) }]}>{aircraft.nickname}</Text>}
          {aircraft.type_designator && (
            <Text style={[styles.acSub, { color: tokens.t3, fontSize: fs(12) }]}>Type {aircraft.type_designator}</Text>
          )}
          {!isOwner && (
            <Pressable onPress={handleLeave} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 2, marginBottom: 4 }}>
              <Text style={[styles.leaveText, { color: tokens.red, fontSize: fs(12.5) }]}>Leave shared aircraft</Text>
            </Pressable>
          )}

          {/* Collaborator roster -- owner-only (get_aircraft_collaborators
              itself raises for anyone else), same reasoning as folder/
              [id].tsx's collabSection: review who has access and revoke it,
              right on the screen the access actually applies to. */}
          {isOwner && collaborators.length > 0 && (
            <View style={[styles.collabSection, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              <View style={styles.collabHeader}>
                <Icon name="person.2.fill" size={fs(15)} color={tokens.t2} />
                <Text style={[styles.collabHeaderText, { color: tokens.t2, fontSize: fs(13) }]}>
                  {collaborators.length} {collaborators.length === 1 ? 'person has' : 'people have'} access
                </Text>
              </View>
              {collaborators.map((c) => (
                <View key={c.userId} style={[styles.collabRow, { borderTopColor: tokens.bdr }]}>
                  <Icon
                    name={c.lastViewedAt ? 'eye.fill' : 'eye.slash'}
                    size={fs(13)}
                    color={c.lastViewedAt ? tokens.grn : tokens.t4}
                  />
                  <Text style={[styles.collabName, { color: tokens.t1, fontSize: fs(13.5) }]} numberOfLines={1}>
                    {c.displayLabel}
                  </Text>
                  <View style={[styles.roleBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}>
                    <Text style={[styles.roleBadgeText, { color: tokens.t3, fontSize: fs(10) }]}>{c.role.toUpperCase()}</Text>
                  </View>
                  <Pressable onPress={() => handleRemoveCollaborator(c)} hitSlop={8}>
                    <Icon name="xmark.circle" size={fs(18)} color={tokens.t4} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <View style={styles.disclaimerCard}>
            <Text style={[styles.disclaimerText, { color: tokens.t3, fontSize: fs(11.5) }]}>
              Self-reported
            </Text>
            <InfoPopup
              id="my-aircraft-equipment-disclaimer"
              title="Equipment & Reminders"
              body="Equipment tags and reminders are based only on what you enter here — FlyRegs doesn't verify serial numbers or maintenance records. ADs shown may apply; always confirm against your aircraft's official records."
              forceOnce
            />
          </View>

          {/* Applicable ADs -- the actual payoff of saving an aircraft at
              all, per explicit direction: this is what the whole feature
              is judged on, so it leads the screen, not Equipment/Reminders.
              Backed by user_ad_notifications (sync/migrations_ad_
              notification_log.sql) -- populated both by the recurring
              weekly sync (new/updated ADs) and by backfillAircraftAds
              (everything that already existed when this aircraft/part was
              added, see adNotifications.ts). Unread dot clears the moment
              an AD is opened, not on a timer or a separate "mark read"
              action. */}
          <View style={styles.sectionHeader}>
            <Pressable style={styles.sectionTitleRow} onPress={() => setAdsCollapsed((v) => !v)} hitSlop={6}>
              <Icon name={adsCollapsed ? 'chevron.right' : 'chevron.down'} size={fs(13)} color={tokens.t3} />
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>APPLICABLE ADs</Text>
              {/* RC: "just list the total w/ a number. '4' is fine. don't
                  need 'new' that is seen w/ the blue dots" -- the separate
                  unread pill was redundant with the per-row unread dots,
                  and two adjacent numbers read as clutter on a phone.
                  Bigger per RC's separate "make count numbers bigger" ask. */}
              {visibleAdNotifications.length > 0 && (
                <Text style={[styles.sectionCountBig, { color: tokens.t4, fontSize: fs(16) }]}>
                  {visibleAdNotifications.length}
                </Text>
              )}
              {/* RC: "applicable info icon is in weird place" -- moved here
                  from its own separate row (see widenSearchRow below),
                  right next to the count it's actually clarifying. */}
              <InfoPopup
                id="my-aircraft-ad-search-scope"
                title="Applicable ADs"
                body="Only shows ADs that specifically name this model or type — an unusually worded AD could be missed."
                iconSize={fs(14)}
              />
            </Pressable>
            {/* Owner-only: editors_manage_shared_ad_notifications only
                grants UPDATE, not INSERT, so an editor tapping this would
                just fail RLS -- see migrations_aircraft_sharing.sql. */}
            {isOwner && (
              <Pressable onPress={handleBackfillAds} hitSlop={10} disabled={backfilling}>
                {backfilling ? <ActivityIndicator size="small" color={tokens.blu} /> : <Icon name="arrow.clockwise" size={fs(18)} color={tokens.blu} />}
              </Pressable>
            )}
          </View>
          {!adsCollapsed && (
            <>
              {/* RC: "we need to inform users about that, so they can
                  choose to widen their search criteria in order to not
                  miss an AD that might still be relevant." This list only
                  includes an AD when its own text specifically names this
                  aircraft's model/type (see flyregs_decisions.md's
                  "AD-to-aircraft matching precision bug fixed" entry) --
                  a real, known tradeoff of that fix is that an AD written
                  with unusual wording could be missed. Links to the full
                  AD search pre-filled on this aircraft's make so a user
                  who wants to double-check can do it in one tap, not a
                  cold search.
                  RC: "'browse all' is packed in there, needs space or
                  move it" -- now its own row with real padding, not
                  crammed alongside the info icon (which moved into the
                  section header above). */}
              <Pressable style={styles.widenSearchRow} onPress={() => router.push(`/ad?q=${encodeURIComponent(aircraft.make)}` as any)}>
                <Text style={[styles.widenSearchText, { color: tokens.blu, fontWeight: '600', fontSize: fs(12.5) }]}>
                  Browse all {aircraft.make} ADs →
                </Text>
              </Pressable>
              {adNotifications.length > 3 && (
                <View style={styles.rangeRow}>
                  {(Object.keys(AD_RANGE_LABELS) as AdRangeFilter[]).map((r) => (
                    <Pressable
                      key={r}
                      onPress={() => setAdRange(r)}
                      style={[
                        styles.rangePill,
                        { borderColor: tokens.bdr },
                        adRange === r && { backgroundColor: tokens.blu, borderColor: tokens.blu },
                      ]}
                    >
                      <Text style={[styles.rangePillText, { color: adRange === r ? '#fff' : tokens.t3, fontSize: fs(11.5) }]}>
                        {AD_RANGE_LABELS[r]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
              {adNotifications.length === 0 ? (
                <Text style={[styles.emptyHint, { color: tokens.t3, fontSize: fs(13) }]}>
                  No Airworthiness Directives currently match this aircraft's make/model or tagged equipment. New or
                  existing ADs that apply will show up here automatically.
                </Text>
              ) : visibleAdNotifications.length === 0 ? (
                <Text style={[styles.emptyHint, { color: tokens.t3, fontSize: fs(13) }]}>
                  No applicable ADs in the selected time range — widen the range above to see older ones.
                </Text>
              ) : (
                <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                  {/* RC: "get rid of all trash cans... in favor of swipe to
                      delete" + "don't need chevron since there's no
                      dropdown. just tap the bar to enter." handleDismissAd
                      already pops its own 2-step confirm Alert (unchanged
                      below), so the swipe reveal just needs to call it. */}
                  {visibleAdNotifications.map((n, i) => (
                    <View
                      key={n.id}
                      style={i < visibleAdNotifications.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }}
                    >
                      <SwipeToDelete
                        onDelete={() => handleDismissAd(n)}
                        onPress={() => handleOpenAd(n)}
                        disabled={!canEdit}
                      >
                        <View style={[styles.row, { backgroundColor: tokens.bg2 }]}>
                          {!n.readAt && <View style={[styles.unreadDot, { backgroundColor: tokens.blu }]} />}
                          <Icon name={n.matchedVia === 'equipment' ? 'wrench' : 'airplane'} size={fs(15)} color={tokens.t3} />
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.rowTitle, { color: tokens.blu, fontSize: fs(14) }]}>AD {n.adNumber}</Text>
                            <Text style={[styles.rowSub, { color: tokens.t2, fontSize: fs(12.5) }]} numberOfLines={2}>{n.subjectHeading}</Text>
                            <Text style={[styles.rowSub, { color: tokens.t4, fontSize: fs(11) }]}>
                              {n.matchedVia === 'equipment' ? 'Equip Match' : 'Airframe Match'}
                              {n.citationPublishDate ? ` · ${n.citationPublishDate}` : ''}
                            </Text>
                          </View>
                        </View>
                      </SwipeToDelete>
                    </View>
                  ))}
                </View>
              )}
            </>
          )}

          <View style={[styles.sectionHeader, { marginTop: 20 }]}>
            <Pressable style={styles.sectionTitleRow} onPress={() => setEquipmentCollapsed((v) => !v)} hitSlop={6}>
              <Icon name={equipmentCollapsed ? 'chevron.right' : 'chevron.down'} size={fs(13)} color={tokens.t3} />
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>EQUIPMENT</Text>
              {equipment.length > 0 && (
                <Text style={[styles.sectionCountBig, { color: tokens.t4, fontSize: fs(16) }]}>{equipment.length}</Text>
              )}
            </Pressable>
            {canEdit && (
              <Pressable onPress={openAddEquipment} hitSlop={10}>
                <Icon name="plus.circle.fill" size={fs(20)} color={tokens.blu} />
              </Pressable>
            )}
          </View>
          {!equipmentCollapsed && (
            equipment.length === 0 ? (
              <Text style={[styles.emptyHint, { color: tokens.t3, fontSize: fs(13) }]}>
                Tag a specific engine, prop, or avionics box so AD alerts also catch part-keyed ADs, not just ones for
                your airframe model.
              </Text>
            ) : (
              <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {equipment.map((e, i) => (
                  <View key={e.id} style={i < equipment.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }}>
                    <SwipeToDelete onDelete={() => handleRemoveEquipment(e)} disabled={!canEdit}>
                      <View style={[styles.row, { backgroundColor: tokens.bg2 }]}>
                        <Icon name="wrench" size={fs(15)} color={tokens.blu} />
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]}>{e.part.name}</Text>
                          {e.part.manufacturer && <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12) }]}>{e.part.manufacturer}</Text>}
                        </View>
                      </View>
                    </SwipeToDelete>
                  </View>
                ))}
              </View>
            )
          )}

          <View style={[styles.sectionHeader, { marginTop: 20 }]}>
            <Pressable style={styles.sectionTitleRow} onPress={() => setRemindersCollapsed((v) => !v)} hitSlop={6}>
              <Icon name={remindersCollapsed ? 'chevron.right' : 'chevron.down'} size={fs(13)} color={tokens.t3} />
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>REMINDERS</Text>
              {reminders.length > 0 && (
                <Text style={[styles.sectionCountBig, { color: tokens.t4, fontSize: fs(16) }]}>{reminders.length}</Text>
              )}
            </Pressable>
            {canEdit && (
              <Pressable onPress={openAddReminder} hitSlop={10}>
                <Icon name="plus.circle.fill" size={fs(20)} color={tokens.blu} />
              </Pressable>
            )}
          </View>
          {!remindersCollapsed && (
            reminders.length === 0 ? (
              <Text style={[styles.emptyHint, { color: tokens.t3, fontSize: fs(13) }]}>
                Add a due date for anything you want a nudge on — ELT battery, transponder check, annual, 100-hour, or
                a compliance part from an AD.
              </Text>
            ) : (
              <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {reminders.map((r, i) => {
                  const days = daysUntil(r.dueDate)
                  const overdue = days < 0
                  const soon = days >= 0 && days <= 30
                  return (
                    <View key={r.id} style={i < reminders.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }}>
                      <SwipeToDelete
                        onDelete={() => handleRemoveReminder(r)}
                        onPress={canEdit ? () => openEditReminder(r) : undefined}
                        disabled={!canEdit}
                      >
                        <View style={[styles.row, { backgroundColor: tokens.bg2 }]}>
                          <Icon name="hourglass" size={fs(15)} color={overdue ? tokens.amb : soon ? tokens.gold : tokens.t3} />
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]}>{r.title}</Text>
                            <Text style={[styles.rowSub, { color: overdue ? tokens.amb : tokens.t3, fontSize: fs(12) }]}>
                              {overdue ? `${Math.abs(days)}d overdue` : days === 0 ? 'Due today' : `Due in ${days}d`} · {r.dueDate}
                              {r.linkedAdNumber ? ` · AD ${r.linkedAdNumber}` : ''}
                            </Text>
                          </View>
                        </View>
                      </SwipeToDelete>
                    </View>
                  )
                })}
              </View>
            )
          )}
        </ScrollView>
      </TabletContainer>

      <PartPickerModal
        visible={partPickerVisible}
        onClose={() => setPartPickerVisible(false)}
        onPicked={async (part) => {
          if (!aircraft) return
          await addAircraftEquipment(aircraft.id, part.id)
          setPartPickerVisible(false)
          load()
          // A newly-tagged part can have real historical ADs of its own --
          // the equipment-keyed match is independent of airframe, so this
          // needs its own backfill call, not just the one on aircraft add.
          backfillAircraftAds(aircraft.id)
            .then((count) => { if (count > 0) getAircraftAdNotifications(aircraft.id).then(setAdNotifications) })
            .catch((e) => console.error('AD backfill failed for new equipment tag:', e?.message ?? e))
        }}
      />
      <ReminderFormModal
        visible={reminderFormVisible}
        editing={editingReminder}
        applicableAds={adNotifications}
        onClose={() => { setReminderFormVisible(false); setEditingReminder(null) }}
        onSaved={async ({ title, dueDate, notes, linkedAdNumber }) => {
          if (!aircraft || !session) return
          try {
            if (editingReminder) {
              await updateAircraftReminder(editingReminder.id, title, dueDate, linkedAdNumber, notes)
            } else {
              await addAircraftReminder(session.user.id, aircraft.id, title, dueDate, linkedAdNumber, notes)
            }
            setReminderFormVisible(false)
            setEditingReminder(null)
            load()
          } catch (e: any) {
            Alert.alert('Could not save reminder', e?.message ?? 'Unknown error')
          }
        }}
      />
    </View>
  )
}

function PartPickerModal({ visible, onClose, onPicked }: { visible: boolean; onClose: () => void; onPicked: (p: AdPart) => void }) {
  const { tokens } = useTheme()
  const fs = useFS()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AdPart[]>([])
  const [relatedTo, setRelatedTo] = useState<PartComponentType | null>(null)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleChange = (text: string) => {
    setQuery(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (text.trim().length < 2) { setResults([]); setRelatedTo(null); return }
    setSearching(true)
    debounceRef.current = setTimeout(() => {
      searchParts(text).then(({ results: hits, relatedTo: rel }) => {
        setResults(hits); setRelatedTo(rel); setSearching(false)
      }).catch(() => setSearching(false))
    }, 250)
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.modalRoot, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Add Equipment" onBack={onClose} />
        <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
          <TextInput
            style={[styles.searchInput, { color: tokens.t1, fontSize: fs(14) }]}
            placeholder="Engine, propeller, avionics part…"
            placeholderTextColor={tokens.t3}
            value={query}
            onChangeText={handleChange}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        {searching ? (
          <ActivityIndicator color={tokens.blu} style={{ marginTop: 20 }} />
        ) : (
          <ScrollView contentContainerStyle={{ padding: 12 }} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled">
            {relatedTo && results.length > 0 && (
              <View style={[styles.relatedNote, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                <Icon name="info.circle" size={fs(14)} color={tokens.t3} />
                <Text style={[styles.relatedNoteText, { color: tokens.t3, fontSize: fs(12.5) }]}>
                  No exact match for "{query.trim()}" — showing {PART_TYPE_LABELS[relatedTo]} parts, the closest category.
                </Text>
              </View>
            )}
            {results.map((p) => (
              <Pressable
                key={p.id}
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, borderWidth: 1, borderRadius: 12, marginBottom: 8 }]}
                onPress={() => onPicked(p)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]}>{p.name}</Text>
                  {p.manufacturer && <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12) }]}>{p.manufacturer}</Text>}
                </View>
                <Icon name="plus.circle.fill" size={fs(20)} color={tokens.blu} />
              </Pressable>
            ))}
            {query.trim().length >= 2 && !searching && results.length === 0 && (
              <Text style={{ color: tokens.t3, fontSize: fs(13), textAlign: 'center', marginTop: 20 }}>
                No matching parts in the catalog yet.
              </Text>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  )
}

// Redesigned add/edit form (RC: scope the Reminders work, then "which
// schema is more flexible and easy to use for the user? ... they should
// still be able to manually adjust a date if needed"). Type chips only
// show in ADD mode -- picking one is a one-time shortcut that fills
// title+date, not a persisted category (no schema column for it), so
// re-showing chips in EDIT mode would imply a selection state that doesn't
// exist once a reminder is saved. Editing works directly on the same
// title/date/notes/AD-link fields either way.
function ReminderFormModal({
  visible, editing, applicableAds, onClose, onSaved,
}: {
  visible: boolean
  editing: AircraftReminder | null
  applicableAds: AircraftAdNotification[]
  onClose: () => void
  onSaved: (input: { title: string; dueDate: string; notes: string; linkedAdNumber: string | null }) => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const [typeKey, setTypeKey] = useState<ReminderTypeKey | null>(null)
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [linkedAdNumber, setLinkedAdNumber] = useState<string | null>(null)
  const [datePickerVisible, setDatePickerVisible] = useState(false)
  const [adPickerVisible, setAdPickerVisible] = useState(false)

  useEffect(() => {
    // RC, real device: tapping a reminder to edit it sometimes did nothing,
    // and the screen eventually stopped responding entirely. Root cause:
    // this form has two of its OWN nested Modals (date picker, AD picker).
    // Their `visible` state lived only in this component and was never
    // reset when the PARENT modal closed -- so dismissing the form via the
    // native swipe-down/back gesture (which fires onRequestClose, not the
    // React state setters a button tap would use) could leave a child
    // Modal's `visible` still `true` while its parent had already closed.
    // Two real native `<Modal>` presentations disagreeing about which of
    // them is "current" is exactly the kind of state iOS's modal host can
    // get stuck on -- the next open (a different reminder's tap) calls
    // setReminderFormVisible(true), which is already true if the close
    // never truly registered, so React sees no change and never re-presents
    // anything ("nothing pops up"). Resetting both on EVERY visibility
    // change (open AND close, not just open) guarantees neither sub-modal
    // can ever outlive its parent.
    setDatePickerVisible(false)
    setAdPickerVisible(false)
    if (!visible) return
    setTypeKey(null)
    setTitle(editing?.title ?? '')
    setDueDate(editing?.dueDate ?? '')
    setNotes(editing?.notes ?? '')
    setLinkedAdNumber(editing?.linkedAdNumber ?? null)
  }, [visible, editing])

  const selectType = (key: ReminderTypeKey) => {
    setTypeKey(key)
    const def = REMINDER_TYPES.find((t) => t.key === key)!
    setTitle(def.defaultTitle)
    setDueDate(def.months != null ? toISODate(addMonths(new Date(), def.months)) : '')
    if (key !== 'ad') setLinkedAdNumber(null)
  }

  const handleSave = () => {
    if (!title.trim()) { Alert.alert('Title required', 'Enter what this reminder is for.'); return }
    if (!DATE_RE.test(dueDate.trim())) { Alert.alert('Pick a due date', 'Use the date picker to set when this is due.'); return }
    onSaved({ title: title.trim(), dueDate: dueDate.trim(), notes, linkedAdNumber })
  }

  return (
    <>
      <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>{editing ? 'Edit Reminder' : 'New Reminder'}</Text>
              <Pressable onPress={onClose} hitSlop={10}>
                <Icon name="xmark" size={fs(18)} color={tokens.t3} />
              </Pressable>
            </View>

            {!editing && (
              <>
                <Text style={[styles.formLabel, { color: tokens.t3, fontSize: fs(11) }]}>TYPE</Text>
                <View style={styles.chipGrid}>
                  {REMINDER_TYPES.map((t) => {
                    const active = typeKey === t.key
                    return (
                      <Pressable
                        key={t.key}
                        style={[
                          styles.typeChip,
                          { backgroundColor: active ? tokens.bdim : tokens.bg2, borderColor: active ? tokens.blu : tokens.bdr },
                        ]}
                        onPress={() => selectType(t.key)}
                      >
                        <Icon name={t.icon} size={fs(15)} color={active ? tokens.blu : tokens.t2} />
                        <Text style={[styles.typeChipText, { color: active ? tokens.blu : tokens.t1, fontSize: fs(12.5) }]}>{t.label}</Text>
                      </Pressable>
                    )
                  })}
                </View>
              </>
            )}

            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="What (e.g. ELT battery, Annual)"
              placeholderTextColor={tokens.t3}
              style={[styles.formInput, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }]}
            />

            <Pressable style={[styles.formInput, styles.dateField, { borderColor: tokens.bdr }]} onPress={() => setDatePickerVisible(true)}>
              <Text style={{ color: dueDate ? tokens.t1 : tokens.t3, fontSize: fs(14.5) }}>{dueDate || 'Due date'}</Text>
              <Icon name="chevron.down" size={fs(14)} color={tokens.t4} />
            </Pressable>

            {(typeKey === 'ad' || (editing && linkedAdNumber)) && (
              <Pressable style={[styles.formInput, styles.dateField, { borderColor: tokens.bdr }]} onPress={() => setAdPickerVisible(true)}>
                <Text style={{ color: linkedAdNumber ? tokens.t1 : tokens.t3, fontSize: fs(14.5) }} numberOfLines={1}>
                  {linkedAdNumber ? `AD ${linkedAdNumber}` : 'Link an Applicable AD (optional)'}
                </Text>
                <Icon name="chevron.down" size={fs(14)} color={tokens.t4} />
              </Pressable>
            )}

            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Notes (optional)"
              placeholderTextColor={tokens.t3}
              style={[styles.formInput, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }]}
            />

            <Pressable style={[styles.addButton, { backgroundColor: tokens.blu }]} onPress={handleSave}>
              <Text style={[styles.addButtonText, { fontSize: fs(14.5) }]}>{editing ? 'Save Changes' : 'Save Reminder'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <DatePickerModal
        visible={datePickerVisible}
        initialDate={dueDate}
        onClose={() => setDatePickerVisible(false)}
        onSelect={setDueDate}
        tokens={tokens}
        fs={fs}
      />

      <Modal visible={adPickerVisible} animationType="slide" transparent onRequestClose={() => setAdPickerVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr, maxHeight: '70%' }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>Link an AD</Text>
              <Pressable onPress={() => setAdPickerVisible(false)} hitSlop={10}>
                <Icon name="xmark" size={fs(18)} color={tokens.t3} />
              </Pressable>
            </View>
            {applicableAds.length === 0 ? (
              <Text style={{ color: tokens.t3, fontSize: fs(13), padding: 12, textAlign: 'center' }}>
                No Applicable ADs found for this aircraft yet.
              </Text>
            ) : (
              <ScrollView style={{ maxHeight: 320 }}>
                {applicableAds.map((ad) => (
                  <Pressable
                    key={ad.id}
                    style={[styles.row, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}
                    onPress={() => { setLinkedAdNumber(ad.adNumber); setAdPickerVisible(false) }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowTitle, { color: tokens.blu, fontSize: fs(14) }]}>AD {ad.adNumber}</Text>
                      <Text style={[styles.rowSub, { color: tokens.t2, fontSize: fs(12.5) }]} numberOfLines={2}>{ad.subjectHeading}</Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </>
  )
}

const DATE_ROW_HEIGHT = 40
const DATE_VISIBLE_ROWS = 5
const CURRENT_YEAR = new Date().getFullYear()
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// Reminders are near-term, forward-looking dates (recurring inspections,
// AD compliance) -- CURRENT_YEAR-1 covers backfilling something already
// slightly overdue, +15 comfortably covers even a long AD compliance
// window without needing an unbounded wheel.
const DATE_YEARS = Array.from({ length: 17 }, (_, i) => CURRENT_YEAR - 1 + i)

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

// Three-wheel month/day/year picker, same snap-scroll mechanics as
// YearPickerModal above (see that component's comment for why plain
// ScrollView + onMomentumScrollEnd + onScroll-debounce over a native
// picker dependency). Reused wholesale here instead of a text input for
// reminder due dates -- RC wanted a "real date picker," and free-text
// YYYY-MM-DD entry was the thing being replaced.
function DatePickerModal({
  visible, initialDate, onClose, onSelect, tokens, fs,
}: {
  visible: boolean
  initialDate: string
  onClose: () => void
  onSelect: (iso: string) => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
}) {
  const parsed = DATE_RE.test(initialDate) ? new Date(initialDate + 'T00:00:00') : new Date()
  const [month, setMonth] = useState(parsed.getMonth() + 1)
  const [day, setDay] = useState(parsed.getDate())
  const [year, setYear] = useState(parsed.getFullYear())

  const monthRef = useRef<ScrollView>(null)
  const dayRef = useRef<ScrollView>(null)
  const yearRef = useRef<ScrollView>(null)
  const settleRefs = useRef<Record<string, ReturnType<typeof setTimeout> | null>>({})

  useEffect(() => {
    if (!visible) return
    const d = DATE_RE.test(initialDate) ? new Date(initialDate + 'T00:00:00') : new Date()
    setMonth(d.getMonth() + 1); setDay(d.getDate()); setYear(d.getFullYear())
    const t = setTimeout(() => {
      monthRef.current?.scrollTo({ y: (d.getMonth() + 1 - 1) * DATE_ROW_HEIGHT, animated: false })
      dayRef.current?.scrollTo({ y: (d.getDate() - 1) * DATE_ROW_HEIGHT, animated: false })
      yearRef.current?.scrollTo({ y: Math.max(0, DATE_YEARS.indexOf(d.getFullYear())) * DATE_ROW_HEIGHT, animated: false })
    }, 50)
    return () => clearTimeout(t)
  }, [visible, initialDate])

  const days = daysInMonth(year, month)
  // Clamp day when switching to a shorter month (e.g. 31 -> Feb) so the
  // wheel never shows a day that doesn't exist for the selected month/year.
  useEffect(() => { if (day > days) setDay(days) }, [days, day])

  const makeHandlers = (key: 'month' | 'day' | 'year', values: number[], setter: (v: number) => void) => {
    const update = (offsetY: number) => {
      const idx = Math.max(0, Math.min(values.length - 1, Math.round(offsetY / DATE_ROW_HEIGHT)))
      setter(values[idx])
    }
    return {
      onMomentumScrollEnd: (e: any) => update(e.nativeEvent.contentOffset.y),
      onScroll: (e: any) => {
        const offsetY = e.nativeEvent.contentOffset.y
        if (settleRefs.current[key]) clearTimeout(settleRefs.current[key]!)
        settleRefs.current[key] = setTimeout(() => update(offsetY), 120)
      },
    }
  }

  const monthValues = Array.from({ length: 12 }, (_, i) => i + 1)
  const dayValues = Array.from({ length: days }, (_, i) => i + 1)
  const wheelHeight = DATE_ROW_HEIGHT * DATE_VISIBLE_ROWS

  const renderWheel = (
    values: number[], selected: number, refObj: React.RefObject<ScrollView | null>,
    handlers: ReturnType<typeof makeHandlers>, labelFor: (v: number) => string, flex: number,
  ) => (
    <View style={{ flex, height: wheelHeight }}>
      <ScrollView
        ref={refObj}
        showsVerticalScrollIndicator={false}
        snapToInterval={DATE_ROW_HEIGHT}
        decelerationRate="fast"
        scrollEventThrottle={32}
        contentContainerStyle={{ paddingVertical: DATE_ROW_HEIGHT * Math.floor(DATE_VISIBLE_ROWS / 2) }}
        {...handlers}
      >
        {values.map((v) => (
          <Pressable
            key={v}
            style={{ height: DATE_ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' }}
            onPress={() => refObj.current?.scrollTo({ y: values.indexOf(v) * DATE_ROW_HEIGHT, animated: true })}
          >
            <Text style={{ color: v === selected ? tokens.t1 : tokens.t3, fontWeight: v === selected ? '700' : '400', fontSize: fs(v === selected ? 16 : 13.5) }}>
              {labelFor(v)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          <View style={styles.modalHeader}>
            <Pressable onPress={onClose} hitSlop={10}><Text style={{ color: tokens.t3, fontSize: fs(14.5) }}>Cancel</Text></Pressable>
            <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>Due Date</Text>
            <Pressable
              onPress={() => { onSelect(toISODate(new Date(year, month - 1, Math.min(day, daysInMonth(year, month))))); onClose() }}
              hitSlop={10}
            >
              <Text style={{ color: tokens.blu, fontWeight: '700', fontSize: fs(14.5) }}>Done</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row', marginTop: 4 }}>
            <View pointerEvents="none" style={{
              position: 'absolute', left: 0, right: 0,
              top: DATE_ROW_HEIGHT * Math.floor(DATE_VISIBLE_ROWS / 2), height: DATE_ROW_HEIGHT,
              borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth,
              borderColor: tokens.bdr, backgroundColor: tokens.bdim,
            }} />
            {renderWheel(monthValues, month, monthRef, makeHandlers('month', monthValues, setMonth), (v) => MONTH_NAMES[v - 1], 1.3)}
            {renderWheel(dayValues, day, dayRef, makeHandlers('day', dayValues, setDay), (v) => String(v), 0.9)}
            {renderWheel(DATE_YEARS, year, yearRef, makeHandlers('year', DATE_YEARS, setYear), (v) => String(v), 1.1)}
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
  relatedNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7,
    borderRadius: 10, borderWidth: 1, padding: 10, marginBottom: 10,
  },
  relatedNoteText: { flex: 1, lineHeight: 17 },
  acLineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  acLine: { fontWeight: '700' },
  acSub: { marginTop: 2, marginBottom: 4 },
  leaveText: { fontWeight: '600' },
  roleBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  roleBadgeText: { fontWeight: '700', letterSpacing: 0.4 },
  collabSection: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', marginTop: 10, marginBottom: 4 },
  collabHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  collabHeaderText: { flex: 1, fontWeight: '600' },
  collabRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  collabName: { flex: 1 },

  disclaimerCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 4,
    padding: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.03)',
  },
  disclaimerText: { flex: 1, lineHeight: 16 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, marginBottom: 8 },
  sectionTitleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5 },
  sectionCountBig: { fontWeight: '700' },
  emptyHint: { lineHeight: 18, marginBottom: 4 },
  widenSearchRow: { paddingVertical: 8, marginBottom: 6 },
  widenSearchText: { lineHeight: 16 },
  rangeRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  rangePill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, borderWidth: 1 },
  rangePillText: { fontWeight: '600' },
  unreadDot: { width: 7, height: 7, borderRadius: 3.5 },

  list: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 },
  rowTitle: { fontWeight: '600' },
  rowSub: { marginTop: 2 },

  modalRoot: { flex: 1 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginTop: 12, height: 42,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12,
  },
  searchInput: { flex: 1 },

  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, gap: 10 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  modalTitle: { fontWeight: '700' },
  formLabel: { fontWeight: '700', letterSpacing: 0.5, marginTop: 2 },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 4 },
  typeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 16, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 7,
  },
  typeChipText: { fontWeight: '600' },
  dateField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  formInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  addButton: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  addButtonText: { color: '#fff', fontWeight: '600', fontSize: 14.5 },
})
