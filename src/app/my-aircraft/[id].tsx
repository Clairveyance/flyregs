import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, ActivityIndicator, Modal, Share, Image, Linking, KeyboardAvoidingView, Platform, Keyboard, AppState } from 'react-native'
import * as Sentry from '@sentry/react-native'
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { TabletContainer } from '@/components/TabletContainer'
import { SwipeToDelete } from '@/components/SwipeToDelete'
import { useConfirm } from '@/components/ConfirmDialog'
import { EditAircraftModal, type UserAircraft } from '@/components/AircraftFormFields'
import { HobbsUpdateModal } from '@/components/HobbsUpdateModal'
import { FindFriendsPickerBody } from '@/components/FindFriendsSheet'
import { BulkInviteContactPicker } from '@/components/BulkInviteContactPicker'
import { supabase } from '@/lib/supabase'
import {
  searchParts, getAircraftEquipment, addAircraftEquipment, removeAircraftEquipment, updateAircraftEquipmentTracking,
  getAircraftReminders, addAircraftReminder, updateAircraftReminder, removeAircraftReminder, PART_TYPE_LABELS,
  type AdPart, type AircraftEquipment, type AircraftReminder, type PartComponentType, type PartTracking,
} from '@/lib/adParts'
import {
  getAircraftAdNotifications, markAdNotificationRead, dismissAdNotification, backfillAircraftAds,
  resyncAircraftAds, markAdComplied, unmarkAdComplied, type AircraftAdNotification,
} from '@/lib/adNotifications'
import {
  getMyAircraftRole, getAircraftCollaborators, removeCollaborator, leaveSharedAircraft,
  inviteCollaboratorByCallsign, buildAircraftShareLink, getOrCreateShareLink, useAircraftRealtime,
  updateCollaboratorRole,
  type CollaboratorRole, type AircraftCollaborator, type FleetRole,
} from '@/lib/aircraftSharing'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'
import { sendCollaborationInvitePush } from '@/lib/notifications'
import { resolveCallsignToUserId } from '@/lib/contactMatch'
import { getAircraftImageUrl, pickAndUploadAircraftImage, takeAndUploadAircraftImage, removeAircraftImage } from '@/lib/aircraftImage'

// Equipment tags are Premium; reminders are Pro+ (see openAddReminder's own
// comment below -- this used to say both were Premium, but that was wrong
// and got fixed without this header comment being updated to match, found
// during the 2026-08-14 gating re-audit). Everything here is either (a) a
// suggestion off a part the user themselves tagged, or (b) a date the user
// themselves entered -- the app verifies none of it independently, which is
// what keeps this low-liability regardless of depth. "May apply" /
// "reminder", never "applies" / "is due" as a fact.

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

function addDays(from: Date, days: number): Date {
  const d = new Date(from)
  d.setDate(d.getDate() + days)
  return d
}

// Quick-select reminder types with hardcoded recurrence defaults -- RC:
// "which schema is more flexible and easy to use for the user? if the
// gating is better and more accurate and more hands off for the user,
// that's good. but they should still be able to manually adjust a date if
// needed to match their exact needs." No schema change: `months`/`days`
// here only pre-fill a SUGGESTED due date at creation time (today + N
// months/days) via DatePickerModal, which the user can still scroll to any
// date they want before saving -- nothing about the interval is enforced or
// re-applied later. 100-Hour is genuinely hobbs/tach-based, not calendar-
// based, so it gets no smart default (`months: null`) -- a suggested date
// would just be wrong. AD Compliance also gets no calendar default since
// compliance intervals vary per AD and aren't modeled in this schema;
// picking that type instead reveals the AD-link picker below.
//
// Pitot-Static and VOR Check added per RC (2026-08-28 in-app feedback).
// Pitot-Static (14 CFR 91.411, IFR) is a real 24-CALENDAR-MONTH interval,
// same shape as Transponder/ELT. VOR Check (14 CFR 91.171, IFR) is a real
// 30-CALENDAR-DAY interval -- genuinely not month-granular, so it's the
// first type here to use `days` instead of `months` (see
// sync/migrations_reminder_interval_days.sql for why that's a separate
// column rather than a rounded month value).
const REMINDER_TYPES = [
  { key: 'annual', label: 'Annual', icon: 'checkmark.seal.fill', defaultTitle: 'Annual Inspection', months: 12, days: null },
  { key: 'transponder', label: 'Transponder', icon: 'dot.radiowaves.left.and.right', defaultTitle: 'Transponder Check', months: 24, days: null },
  { key: 'elt', label: 'ELT Battery', icon: 'bolt.fill', defaultTitle: 'ELT Battery', months: 24, days: null },
  { key: 'pitot-static', label: 'Pitot-Static', icon: 'waveform.path.ecg', defaultTitle: 'Pitot-Static Check', months: 24, days: null },
  { key: 'vor-check', label: 'VOR Check', icon: 'location.north.line', defaultTitle: 'VOR Equipment Check', months: null, days: 30 },
  { key: '100hour', label: '100-Hour', icon: 'speedometer', defaultTitle: '100-Hour Inspection', months: null, days: null },
  { key: 'ad', label: 'AD Compliance', icon: 'wrench.and.screwdriver.fill', defaultTitle: 'AD Compliance', months: null, days: null },
  { key: 'custom', label: 'Custom', icon: 'pencil', defaultTitle: '', months: null, days: null },
] as const
type ReminderTypeKey = (typeof REMINDER_TYPES)[number]['key']

// RC: "these reminder boxes need to also show the selected length of the
// reminder (12mo, 24mo, etc) and they all also have to have that bar be
// editable with a custom length." Separate from the TYPE picker above --
// this is the actual persisted `interval_months` (see adParts.ts /
// migrations_reminder_interval.sql), shown and editable on EVERY reminder,
// not just at creation. "None" covers 100-Hour/AD/Custom reminders with no
// fixed calendar recurrence.
const LENGTH_PRESETS = [6, 12, 24, 36] as const
// Day-based counterpart, for reminders on a real sub-month regulatory cycle
// (VOR Check, 30 days). Same "None / presets / Custom" bar shape as
// LENGTH_PRESETS above, just a different unit -- see intervalDays.
const DAY_LENGTH_PRESETS = [30] as const

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
  const ifs = useInputFS()
  const insets = useSafeAreaInsets()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web (silently, no throw, no log), so every dialog on this
  // screen was invisible during Browser-pane QA and the actions behind
  // them untestable. See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  // `loading: authLoading` -- every tier gate in this file is guarded with
  // `if (!authLoading)` before it navigates. isPro/isPremium/isUnlocked all
  // START false and only become authoritative once auth's own `loading`
  // resolves: on cold launch, and again on the SIGNED_IN event a Face ID
  // sign-in raises (see context/auth.tsx's own comment on that). This screen
  // is reachable by share link and by push-notification deep link, so a real
  // subscriber genuinely can be looking at it, and tapping its header
  // controls, inside that window -- and the un-guarded gates would have sent
  // them to a paywall for a tier they already pay for. Doing nothing for the
  // fraction of a second it takes to resolve is the lesser evil; a second tap
  // once entitlements land behaves normally. Same principle as
  // (tabs)/index.tsx's HobbsHeaderButton, which refuses to act on the same
  // transient false.
  const { session, isPremium, hasProAccess, loading: authLoading } = useAuth()
  // Collaborator display names on this screen can run long and get cut off
  // the same way FAR Part titles do -- same hook/card pair as far/index.tsx's
  // own long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()
  const [aircraft, setAircraft] = useState<UserAircraft | null>(null)
  const [adNotifications, setAdNotifications] = useState<AircraftAdNotification[]>([])
  const [adRange, setAdRange] = useState<AdRangeFilter>('all')
  const [backfilling, setBackfilling] = useState(false)
  const [equipment, setEquipment] = useState<AircraftEquipment[]>([])
  const [reminders, setReminders] = useState<AircraftReminder[]>([])
  const [loading, setLoading] = useState(true)
  const [partPickerVisible, setPartPickerVisible] = useState(false)
  // RC: "the equipment section doesn't seem to be editable" -- real gap,
  // not a misread: the row had swipe-to-delete but no onPress at all,
  // unlike Reminders' own tap-to-edit. An equipment tag has no separate
  // fields to edit beyond "which part" (added_at aside), so "edit" here
  // means re-opening the same part picker and swapping the tag rather than
  // a pre-filled form the way ReminderFormModal works for reminders.
  const [editingEquipment, setEditingEquipment] = useState<AircraftEquipment | null>(null)
  // Drives PartTrackingModal below -- 'new' for a part just picked in
  // PartPickerModal (not inserted yet, tracking is entered before the
  // first insert), 'edit' for tapping an already-tagged part's row to
  // change its interval/due values. RC: "each part box needs an input
  // sheet" for the specific date/hour requirement of that part.
  const [trackingTarget, setTrackingTarget] = useState<
    { mode: 'new'; part: AdPart } | { mode: 'edit'; equipment: AircraftEquipment } | null
  >(null)
  const [reminderFormVisible, setReminderFormVisible] = useState(false)
  const [editingReminder, setEditingReminder] = useState<AircraftReminder | null>(null)
  const [hobbsModalVisible, setHobbsModalVisible] = useState(false)
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
  // Drives the share modal below. 'role' shows the Viewer/Editor choice,
  // 'callsign' shows the Callsign field, 'findFriends' shows the contacts
  // picker -- all three are steps of the SAME <Modal>, never two separate
  // ones (see shareStep's own comment at the modal for why that split used
  // to freeze the screen on native -- Find Friends briefly reintroduced the
  // identical bug as its own separate <Modal> before this).
  const [shareStep, setShareStep] = useState<'closed' | 'role' | 'callsign' | 'findFriends'>('closed')
  const [inviteRole, setInviteRole] = useState<CollaboratorRole | null>(null)
  const [inviteCallsign, setInviteCallsign] = useState('')
  const [inviteError, setInviteError] = useState<string | null>(null)
  // RC (real device, 2026-08-15): "it doesn't confirm if what you're
  // entering exists or not... it just opens the iOS typical 'send to...'
  // screen." The server already resolves the callsign inside the invite
  // RPC (see resolveCallsignToUserId's own comment on why nothing called
  // it before), but that only surfaces a typo AFTER a full submit attempt.
  // Debounced so it doesn't fire on every keystroke.
  const [callsignCheck, setCallsignCheck] = useState<'idle' | 'checking' | 'found' | 'not_found'>('idle')
  useEffect(() => {
    const trimmed = inviteCallsign.trim()
    if (!trimmed) { setCallsignCheck('idle'); return }
    setCallsignCheck('checking')
    const t = setTimeout(() => {
      resolveCallsignToUserId(trimmed)
        .then((userId) => setCallsignCheck(userId ? 'found' : 'not_found'))
        .catch(() => setCallsignCheck('idle'))
    }, 400)
    return () => clearTimeout(t)
  }, [inviteCallsign])
  // RC: "the a/c invite area should also be able to invite new people (of
  // course that invite comes with the Prem paywall to sub)." The Callsign
  // flow only ever worked for someone who already has a FlyRegs account --
  // aircraftSharing.ts already had a complete, working anonymous-link path
  // (getOrCreateShareLink + join_shared_aircraft's own share_code branch,
  // matching folder's identical dual-path design and already paywalling
  // the joiner correctly in join/[token].tsx's needs_premium state) that
  // this screen's own invite UI simply never called. Chosen BEFORE the
  // role step (unlike folder, aircraft's link needs a role baked in, so
  // every method has to pass through 'role' regardless) so pickRole below
  // knows which of the 3 real actions to take once a role is picked.
  const [inviteMethod, setInviteMethod] = useState<'callsign' | 'link' | 'multiple'>('callsign')
  const [bulkInviteVisible, setBulkInviteVisible] = useState(false)
  const bulkInviteTokenRef = useRef<string | null>(null)
  // RC: "the editing takes place once inside the a/c page. Make sure
  // editing IS available inside for all things." Owner+editor can both
  // update user_aircraft per the live RLS (editors_update_shared_aircraft).
  const [editingAircraft, setEditingAircraft] = useState<UserAircraft | null>(null)

  const load = useCallback(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      supabase.from('user_aircraft').select('id, make, model, nickname, type_designator, year, current_hobbs_hours, hobbs_updated_at, image_path').eq('id', id).single(),
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
    }).catch((e) => {
      // Promise.all rejects as a whole, and three of its five legs throw on
      // error (getAircraftAdNotifications / getAircraftEquipment /
      // getAircraftReminders all `throw error`). With no catch here, a
      // single transient network blip meant setLoading(false) never ran and
      // this screen sat on its spinner forever -- and the AppState 'active'
      // listener below would just set loading true again on every
      // foreground, so backgrounding and returning couldn't clear it either.
      // Falling through to the "Aircraft not found" state is recoverable
      // (Back, then re-open) instead of a dead screen.
      console.error('Failed to load aircraft detail:', e?.message ?? e)
      setLoading(false)
    })
  }, [id])

  // useFocusEffect, not a plain mount-only useEffect -- matches
  // folder/[id].tsx's own identical fix. RC: "we still need to track/log
  // when an a/c is being shared" -- without this, an owner who shares an
  // aircraft and stays on this same screen never sees a collaborator's
  // acceptance land (no refetch, no realtime subscription) until they
  // navigate away and back, which reads as the roster silently not
  // updating even though the join genuinely succeeded server-side.
  useFocusEffect(useCallback(() => { load() }, [load]))

  // This screen had ONLY the useFocusEffect above -- no AppState listener,
  // no realtime subscription -- found by a QA sweep testing the same class
  // of issue RC raised for shared folders (immediate r/w-access-change
  // propagation). Same two-part fix as both folder screens got earlier:
  // foreground refresh here, live push via useAircraftRealtime below.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') load()
    })
    return () => sub.remove()
  }, [load])

  useAircraftRealtime(typeof id === 'string' ? id : undefined, load)

  const isOwner = role === 'owner'
  const canEdit = role === 'owner' || role === 'editor'

  // Ryan (Suggest a feature, 2026-08-30, submission 71a906b7): "utilize the
  // same code that we used in the user profile avatars." Same error
  // handling as account.tsx's own runAvatarPick (PERMISSION_DENIED ->
  // Settings prompt, CANCELLED -> silent, anything else -> Sentry + a real
  // error dialog) -- no optimistic local-uri override here, unlike avatars,
  // since this photo only ever renders on this one screen at a time rather
  // than several screens needing to agree on it simultaneously.
  const [photoBusy, setPhotoBusy] = useState(false)
  const runAircraftImagePick = async (source: (onLocalUri: (uri: string) => void) => Promise<string>) => {
    if (!aircraft || photoBusy) return
    setPhotoBusy(true)
    try {
      const path = await source(() => {})
      setAircraft((prev) => (prev ? { ...prev, image_path: path } : prev))
    } catch (err: any) {
      if (err?.message === 'PERMISSION_DENIED') {
        confirm({
          title: 'Access Disabled',
          message: 'FlyRegs needs access to your camera or photos to set an aircraft photo. Enable it in Settings.',
          confirmLabel: 'Open Settings',
          onConfirm: () => Linking.openSettings(),
        })
      } else if (err?.message !== 'CANCELLED') {
        Sentry.captureException(err)
        confirm({ title: 'Error', message: 'Could not update this aircraft’s photo.', cancelLabel: null })
      }
    }
    setPhotoBusy(false)
  }

  const handlePickAircraftImage = () => {
    if (!aircraft || photoBusy) return
    confirm({
      title: 'Aircraft Photo',
      choices: [
        // The current image_path is passed through so the upload can delete
        // the object it replaces -- each upload now lands on its own
        // content-addressed name (see aircraftImage.ts) rather than
        // overwriting a fixed one, so nothing else would ever reclaim it.
        { label: 'Take Photo', onPress: () => { setTimeout(() => runAircraftImagePick((onLocalUri) => takeAndUploadAircraftImage(aircraft.id, aircraft.image_path ?? null, onLocalUri)), 300) } },
        { label: 'Choose from Library', onPress: () => { setTimeout(() => runAircraftImagePick((onLocalUri) => pickAndUploadAircraftImage(aircraft.id, aircraft.image_path ?? null, onLocalUri)), 300) } },
        ...(aircraft.image_path ? [{
          label: 'Remove Photo', destructive: true, onPress: () => {
            setTimeout(async () => {
              setPhotoBusy(true)
              try {
                await removeAircraftImage(aircraft.id, aircraft.image_path ?? null)
                setAircraft((prev) => (prev ? { ...prev, image_path: null } : prev))
              } catch (err) {
                Sentry.captureException(err)
                confirm({ title: 'Error', message: 'Could not remove this photo.', cancelLabel: null })
              }
              setPhotoBusy(false)
            }, 300)
          },
        }] : []),
      ],
    })
  }

  // RC: "make sure to fix the owner sharing perms for Fleet - Prem only,
  // both ends." The joiner side was already gated on isPremium
  // (join/[token].tsx) but this owner side wasn't -- a plain Pro owner
  // could tap Share and mint a real invite link before this, same gate
  // folder/[id].tsx already has for its own owner-side Share.
  // RC real-device report: tapping Invite froze the screen. Root cause --
  // this used to open confirm()'s own action-sheet Modal for the Viewer/
  // Editor choice, whose onPress ALSO set inviteRole, which opened a SECOND
  // separate <Modal> (the Callsign field below) for the Callsign step. Two
  // RN <Modal>s wanting to be visible in the same render (one presenting
  // while the other is still mid-dismiss) is a known iOS UIKit deadlock --
  // invisible on web, where Modal is just a portal div with no native
  // presentation stack to wedge. Folded both steps into the ONE modal below
  // instead of ever mounting two.
  //
  // RC, real device, a SEPARATE report the same night: "The sharing an
  // invitation process inside the Aircraft section is completely broken...
  // if a screen does pop up to select how you want to invite them, like as
  // a viewer or editor, if you select one of those, then there's no screen
  // that pops up for you to actually select who you want to invite." This
  // is the exact same deadlock class as the paragraph above, just ONE STEP
  // EARLIER and never caught by that fix: handleShare's own confirm() sheet
  // (Callsign/Link/Multiple) is ConfirmDialog's <Modal>; its runChoice()
  // calls `await c.onPress()` and only closes that Modal (via closeIfCurrent)
  // AFTER onPress returns. Every choice below used to call setShareStep('role')
  // SYNCHRONOUSLY, which sets the 'role' Modal's own visible=true in the
  // SAME commit runChoice's `setBusy(true)` renders with opts (and therefore
  // this sheet's Modal) still non-null -- two RN <Modal>s both wanting to be
  // visible at once, the identical deadlock, just at the method-choice ->
  // role-picker handoff instead of the role-picker -> Callsign-field handoff.
  // folder/[id].tsx's handleInviteChoice hit and fixed this same shape for
  // its own "Invite by Callsign" choice (see that function's own comment,
  // 2026-08-22 re-report) by deferring past this sheet's own fade-out
  // (animationType "fade" on ConfirmDialog's Modal) with a setTimeout --
  // applying the identical fix here, since this call site was never audited
  // against that fix (different file, different choice list). This alone
  // explains RC's blanket "not through call sign, not through a text
  // message, nothing" for the separate can't-even-send-it complaint too --
  // ALL THREE invite methods route through this same confirm() sheet, so
  // all three were equally blocked at this single choke point.
  const handleShare = () => {
    if (!aircraft) return
    if (!isPremium) { if (!authLoading) router.push('/paywall?tier=premium'); return }
    confirm({
      title: 'Share this aircraft',
      choices: [
        { label: 'Invite by Callsign', onPress: () => { setTimeout(() => { setInviteMethod('callsign'); setShareStep('role') }, 300) } },
        { label: 'Invite by Link', onPress: () => { setTimeout(() => { setInviteMethod('link'); setShareStep('role') }, 300) } },
        { label: 'Invite Multiple (Contacts)', onPress: () => { setTimeout(() => { setInviteMethod('multiple'); setShareStep('role') }, 300) } },
      ],
    })
  }

  const pickRole = async (r: CollaboratorRole) => {
    setInviteError(null)
    setInviteCallsign('')
    setInviteRole(r)
    if (inviteMethod === 'callsign') {
      setShareStep('callsign')
      return
    }
    if (!aircraft) return
    setSharingBusy(true)
    let link: string, token: string
    try {
      ;({ link, token } = await getOrCreateShareLink(aircraft.id, r))
    } catch {
      setSharingBusy(false)
      closeShareModal()
      confirm({ title: 'Error', message: 'Could not create an invite link. Try again in a moment.', cancelLabel: null })
      return
    }
    setSharingBusy(false)
    // Both branches below close THIS modal, then hand off to a second
    // presenter (the OS share sheet, or BulkInviteContactPicker's own real
    // RN <Modal>) -- deferred 300ms, same value and same reason as
    // handleShare's own fix above. closeShareModal() and the hand-off used
    // to fire in the exact same commit (no await between them), which for
    // 'multiple' is the identical two-RN-<Modal>-at-once deadlock (this
    // modal's slide-out dismiss racing BulkInviteContactPicker's own
    // present), and for 'link' is the same iOS UIKit collision one level
    // down: Share.share() presents a UIActivityViewController through the
    // same present/dismiss API family RN's <Modal> uses under the hood, so
    // calling it while this modal is still mid-dismiss carries the same
    // risk. Not something this file's own 2026-08-15 real-device report
    // called out by name, but the exact same shape as the two deadlocks that
    // WERE reported (see handleShare above) -- fixed alongside them rather
    // than left as a live landmine one tap further into the same flow.
    if (inviteMethod === 'link') {
      closeShareModal()
      setTimeout(async () => {
        try {
          await Share.share({ message: link })
        } catch {
          // Link is already live either way -- a cancelled/unavailable share
          // sheet isn't a real failure, same reasoning as submitInvite below.
          confirm({ title: 'Invite link ready', message: 'Copy or share this link:', linkMessage: link, cancelLabel: null })
        }
      }, 300)
      return
    }
    // 'multiple' -- hand the same link's token to the real multi-select
    // contact picker, same as folder's own openBulkInvite.
    bulkInviteTokenRef.current = token
    closeShareModal()
    setTimeout(() => setBulkInviteVisible(true), 300)
  }

  const closeShareModal = () => {
    setShareStep('closed')
    setInviteRole(null)
  }

  const handleBulkInviteSent = (sentCount: number) => {
    setBulkInviteVisible(false)
    if (sentCount > 0) {
      confirm({ title: 'Invites sent', message: `Sent to ${sentCount} contact${sentCount === 1 ? '' : 's'}.`, cancelLabel: null })
    } else {
      confirm({ title: 'No invites sent', message: 'Every message was cancelled before sending. Nothing was shared.', cancelLabel: null })
    }
  }

  // RC: "we still need to track/log when an a/c is being shared" -- and
  // on identifying the recipient: "the 'name' [is] the person's Callsign
  // from the app." Targets one specific FlyRegs account instead of
  // handing out an anonymous link, which is what makes the pending/
  // greyed-out roster state below possible at all -- you can't show
  // "invited" for a person the app has no idea was invited.
  const submitInvite = async () => {
    if (!aircraft || !inviteRole) return
    setSharingBusy(true)
    setInviteError(null)
    let invite: Awaited<ReturnType<typeof inviteCollaboratorByCallsign>>
    try {
      invite = await inviteCollaboratorByCallsign(aircraft.id, inviteCallsign, inviteRole)
    } catch (e: any) {
      setInviteError(e?.message ?? 'Could not create invite')
      setSharingBusy(false)
      return
    }
    closeShareModal()
    // A named invite already knows exactly who it's for -- push the
    // resolved user directly instead of opening the OS share sheet, which
    // made no sense for a callsign (RC, real device, 2026-08-15: "it
    // shouldn't do that at all, with a callsign... should simply locate
    // the user with that callsign and send them the invite").
    const label = aircraft.nickname || `${aircraft.make} ${aircraft.model}`
    sendCollaborationInvitePush(invite.userId, 'aircraft', label, invite.token).catch(() => {})
    confirm({ title: 'Invite sent', message: `Sent to @${invite.callsign}.`, cancelLabel: null })
    getAircraftCollaborators(aircraft.id).then(setCollaborators).catch(() => {})
    setSharingBusy(false)
  }

  // RC: "yes, build the a/c sharing change role capability" -- an owner can
  // now flip an already-joined collaborator between viewer/editor, not just
  // pick a role at invite time. Optimistic + rollback-on-failure, same
  // pattern as folder/[id].tsx's handleSetCollaboratorMode.
  const handleSetCollaboratorRole = async (c: AircraftCollaborator, role: CollaboratorRole) => {
    if (!aircraft || role === c.role) return
    setCollaborators((prev) => prev.map((x) => (x.userId === c.userId ? { ...x, role } : x)))
    try {
      await updateCollaboratorRole(aircraft.id, c.userId, role)
    } catch {
      setCollaborators((prev) => prev.map((x) => (x.userId === c.userId ? { ...x, role: c.role } : x)))
      confirm({ title: 'Error', message: 'Could not update access. Try again in a moment.', cancelLabel: null })
    }
  }

  const handleRemoveCollaborator = (c: AircraftCollaborator) => {
    if (!aircraft) return
    confirm({
      title: c.accepted ? 'Remove Access' : 'Revoke Invite',
      message: c.accepted
        ? `Remove ${c.displayLabel} from this aircraft? They'll need a new invite to get back in.`
        : `Revoke the invite sent to ${c.displayLabel}? They won't be able to accept it.`,
      confirmLabel: c.accepted ? 'Remove' : 'Revoke',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await removeCollaborator(aircraft.id, c.userId)
        setCollaborators((prev) => prev.filter((x) => x.userId !== c.userId))
      },
    })
  }

  const handleLeave = () => {
    if (!aircraft) return
    const label = aircraft.nickname || `${aircraft.make} ${aircraft.model}`
    confirm({
      title: 'Leave Shared Aircraft',
      message: `You'll lose access to ${label} until invited again.`,
      confirmLabel: 'Leave',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await leaveSharedAircraft(aircraft.id)
        router.back()
      },
    })
  }

  const visibleAdNotifications = useMemo(
    () => adNotifications.filter((n) => withinAdRange(n.citationPublishDate, adRange)),
    [adNotifications, adRange]
  )
  // Complied ADs stay IN the list (a reviewable record, not a todo list
  // that empties out) but shouldn't count toward "needs attention" in the
  // header -- same "open" meaning get_fleet_summary() and the Fleet list
  // chips already use.
  const openAdCount = useMemo(() => visibleAdNotifications.filter((n) => !n.compliedAt).length, [visibleAdNotifications])
  const handleOpenAd = (n: AircraftAdNotification) => {
    if (!n.readAt) {
      // Optimistic -- the whole point of the unread dot is that it clears
      // the moment the user actually looks at it, not after a round trip.
      setAdNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)))
      markAdNotificationRead(n.id).catch((e) => console.error('Failed to mark AD notification read:', e?.message ?? e))
    }
    router.push(`/ad/${n.adNumber}` as any)
  }

  // resync, not backfill: backfill is INSERT-only, so this control could
  // only ever grow the list -- an aircraft whose make/model/type was
  // corrected kept every AD matched under its OLD identity forever, with
  // no way to clear them but dismissing each one by hand (confirmed live,
  // see resyncAircraftAds' own comment). Now it re-derives the airframe
  // matches from what the aircraft actually is, which is what "recheck"
  // always looked like it did.
  const handleBackfillAds = async () => {
    if (!aircraft) return
    setBackfilling(true)
    try {
      const { removed, added } = await resyncAircraftAds(aircraft.id)
      const ads = await getAircraftAdNotifications(aircraft.id)
      setAdNotifications(ads)
      const parts: string[] = []
      if (added > 0) parts.push(`Found ${added} more Airworthiness Directive${added === 1 ? '' : 's'}.`)
      if (removed > 0) parts.push(`Removed ${removed} that no longer match this aircraft.`)
      confirm({
        title: parts.length > 0 ? 'Applicable ADs updated' : 'Up to date',
        message: parts.length > 0 ? parts.join(' ') : 'No changes — this list already matches your aircraft.',
        cancelLabel: null,
      })
    } catch (e: any) {
      confirm({ title: 'Could not check for ADs', message: e?.message ?? 'Unknown error', cancelLabel: null })
    }
    setBackfilling(false)
  }

  const handleDismissAd = (n: AircraftAdNotification) => {
    confirm({
      title: `Remove AD ${n.adNumber}?`,
      message: "This removes it from this aircraft's list. It won't come back on future AD syncs unless you add it again yourself.",
      confirmLabel: 'Remove',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        setAdNotifications((prev) => prev.filter((x) => x.id !== n.id))
        try {
          await dismissAdNotification(n.id)
        } catch (e: any) {
          setAdNotifications((prev) => [...prev, n]) // roll back on failure
          // Rethrown, not a second dialog -- the confirm shows it inline.
          // The old pattern fired a SECOND Alert.alert here, which on web
          // meant the removal silently failed AND silently said nothing.
          throw e
        }
      },
    })
  }

  // RC: "yeah build the Fleet schema. keep it feature rich but avoid any
  // word use that smells of legal or liability on our part. can be
  // handled w/ CTA disclaimer if need be to log that we advised." The
  // confirm text itself IS that disclaimer -- no separate acknowledgment
  // flag, matching every other confirm on this screen.
  const handleMarkComplied = (n: AircraftAdNotification) => {
    confirm({
      title: `Mark AD ${n.adNumber} complied?`,
      message: "This records that you've completed what this AD requires. FlyRegs doesn't independently verify compliance -- always keep your own maintenance records as the official source.",
      confirmLabel: 'Mark Complied',
      onConfirm: async () => {
        await markAdComplied(n.id, null)
        load()
      },
    })
  }

  const handleUnmarkComplied = (n: AircraftAdNotification) => {
    confirm({
      title: `Un-mark AD ${n.adNumber}?`,
      message: 'This moves it back to open.',
      confirmLabel: 'Un-mark',
      onConfirm: async () => {
        await unmarkAdComplied(n.id)
        load()
      },
    })
  }

  const handleRemoveEquipment = (e: AircraftEquipment) => {
    confirm({
      title: `Remove ${e.part.name}?`,
      message: 'This untags the part from this aircraft -- AD alerts matched only by this equipment will stop appearing.',
      confirmLabel: 'Remove',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await removeAircraftEquipment(e.id)
        setEquipment((prev) => prev.filter((x) => x.id !== e.id))
      },
    })
  }

  const handleRemoveReminder = (r: AircraftReminder) => {
    confirm({
      title: `Delete "${r.title}"?`,
      message: 'This reminder will be permanently removed.',
      confirmLabel: 'Delete',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await removeAircraftReminder(r.id)
        setReminders((prev) => prev.filter((x) => x.id !== r.id))
      },
    })
  }

  const openAddEquipment = () => {
    if (!isPremium) { if (!authLoading) router.push('/paywall?tier=premium'); return }
    setEditingEquipment(null)
    setPartPickerVisible(true)
  }

  // Tapping an already-tagged part now opens its own tracking sheet
  // (interval/due date/due hobbs) rather than immediately re-opening the
  // part picker -- swapping which part this is is the rare case now,
  // reachable via "Change Part" inside PartTrackingModal instead.
  const openTrackEquipment = (e: AircraftEquipment) => {
    if (!isPremium) { if (!authLoading) router.push('/paywall?tier=premium'); return }
    setTrackingTarget({ mode: 'edit', equipment: e })
  }

  // The Equipment round trip is the LAST un-deferred close+open handoff left
  // on this screen, and it's the same two-RN-<Modal>s-at-once deadlock
  // handleShare above already carries the full writeup for -- just between
  // two of this file's own sheets instead of ConfirmDialog's. "Change Part"
  // lives inside PartTrackingModal's <Modal>; setTrackingTarget(null) starts
  // that Modal's slide-out dismiss, and setPartPickerVisible(true) used to
  // set PartPickerModal's own visible=true in the SAME commit -- iOS is then
  // asked to present one modal on a view controller that's still mid-dismiss
  // of another, and neither ends up presented (invisible on web, where Modal
  // is just a portal div with no native presentation stack to wedge).
  // Deferred past the dismiss with the same setTimeout(..., 300) as
  // handleShare/submitInvite/handlePickAircraftImage above.
  //
  // Found by the corpus-wide sweep of this bug class, NOT by an independent
  // real-device report -- same standing as the link-share and bulk-contacts
  // hand-offs fixed defensively alongside handleShare's own reported break.
  // See PartPickerModal's onPicked below for the other direction of this same
  // round trip, which had the identical shape.
  const changeEquipmentPart = () => {
    if (trackingTarget?.mode !== 'edit') return
    setEditingEquipment(trackingTarget.equipment)
    setTrackingTarget(null)
    setTimeout(() => setPartPickerVisible(true), 300)
  }

  const handleSaveTracking = async (tracking: PartTracking) => {
    if (!aircraft || !trackingTarget) return
    try {
      if (trackingTarget.mode === 'new') {
        await addAircraftEquipment(aircraft.id, trackingTarget.part.id, tracking)
        setTrackingTarget(null)
        load()
        // Same reasoning as the picker's own backfill call below -- a newly
        // tagged part can carry real historical ADs of its own.
        backfillAircraftAds(aircraft.id)
          .then((count) => { if (count > 0) getAircraftAdNotifications(aircraft.id).then(setAdNotifications) })
          .catch((e) => console.error('AD backfill failed for new equipment tag:', e?.message ?? e))
      } else {
        await updateAircraftEquipmentTracking(trackingTarget.equipment.id, tracking)
        setTrackingTarget(null)
        load()
      }
    } catch (e: any) {
      // Was unguarded -- a thrown save left the modal's own Save button
      // stuck disabled forever (see PartTrackingModal.handleSave) with no
      // indication anywhere of what went wrong.
      confirm({ title: 'Could not save tracking', message: e?.message ?? 'Unknown error. Try again.', cancelLabel: null })
    }
  }

  const openAddReminder = () => {
    // Pro+ per the standing push policy ("reminders push Pro+, AD alerts
    // Premium-only") -- this was wrongly gated at isPremium, silently
    // blocking every Pro user from creating a reminder at all, contradicting
    // the FAQ's own "Reminders you set yourself push to your device on Pro
    // and Premium" line.
    if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
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

  // Combined into one header row rather than a separate edit affordance
  // elsewhere on the page -- same reasoning as folders' own header, which
  // already puts rename/share/delete together in one place.
  const headerActions = (
    <View style={styles.headerActions}>
      {canEdit && (
        <Pressable onPress={() => setEditingAircraft(aircraft)} hitSlop={10} style={{ padding: 6 }}>
          <Icon name="pencil" size={fs(20)} color={tokens.t2} />
        </Pressable>
      )}
      {isOwner && (
        <Pressable onPress={handleShare} hitSlop={10} disabled={sharingBusy} style={{ padding: 6 }}>
          <Icon name="person.2.fill" size={fs(21)} color={tokens.t2} />
        </Pressable>
      )}
    </View>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        title={aircraft.nickname || `${aircraft.make} ${aircraft.model}`}
        onBack={() => router.back()}
        right={headerActions}
      />
      <TabletContainer>
        <ScrollView contentContainerStyle={styles.content}>
          {/* Ryan (Suggest a feature, 2026-08-30, submission 590f4a48): "when
              you actually open up the Aircraft page itself, we could
              probably put that Aircraft image here in this empty space at
              the top." Owner/editor with no photo yet sees a tappable
              placeholder that opens the same picker; a viewer with no photo
              sees nothing at all, matching every other edit-only affordance
              on this screen. */}
          {aircraft.image_path ? (
            <Pressable onPress={canEdit ? handlePickAircraftImage : undefined} disabled={photoBusy}>
              <Image source={{ uri: getAircraftImageUrl(aircraft.image_path) ?? undefined }} style={styles.heroImage} />
              {photoBusy && (
                <View style={[styles.heroImageOverlay, { backgroundColor: tokens.bg + 'aa' }]}>
                  <ActivityIndicator color={tokens.blu} />
                </View>
              )}
            </Pressable>
          ) : canEdit ? (
            <Pressable
              style={[styles.heroPlaceholder, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}
              onPress={handlePickAircraftImage}
              disabled={photoBusy}
            >
              {photoBusy ? (
                <ActivityIndicator color={tokens.blu} />
              ) : (
                <>
                  <Icon name="camera" size={fs(22)} color={tokens.t3} />
                  <Text style={[styles.heroPlaceholderText, { color: tokens.t3, fontSize: fs(13) }]}>Add a photo</Text>
                </>
              )}
            </Pressable>
          ) : null}
          <View style={styles.acLineRow}>
            <Text style={[styles.acLine, { color: tokens.t1, fontSize: fs(17) }]}>{aircraft.make} {aircraft.model}</Text>
            {!isOwner && role && (
              <View style={[styles.roleBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}>
                <Text style={[styles.roleBadgeText, { color: tokens.t3, fontSize: fs(10) }]}>{role.toUpperCase()}</Text>
              </View>
            )}
            {/* RC: "we need a small note informing of read/write access...
                this can come up once, then should be hidden, with an info
                icon." The join screen already explains this once, right
                when the role is decided -- this is just the icon for
                anyone who wants the reminder later, tacked onto the badge
                that's already there rather than a whole separate note. */}
            {!isOwner && role && (
              <InfoPopup
                id="my-aircraft-role-access"
                title={role === 'editor' ? 'Editor access' : 'Viewer access'}
                body={
                  role === 'editor'
                    ? "You can add, edit, and remove this aircraft's equipment, reminders, and ADs. You can't remove the aircraft itself or manage who else has access."
                    : "You can view this aircraft's equipment, reminders, and ADs, but can't make changes. Ask the owner for editor access if you need to."
                }
                iconSize={fs(14)}
              />
            )}
            {/* RC: "this is just taking up too much real estate for a tiny
                info icon" -- was its own full-width disclaimer card;
                that's just this one icon now, tucked into the title row
                the same way the role-access icon above is. Full
                explanation still lives in the popup, unchanged. */}
            <InfoPopup
              id="my-aircraft-equipment-disclaimer"
              title="Equipment & Reminders"
              body={[
                "Equipment tags and reminders are based only on what you enter here — FlyRegs doesn't verify serial numbers or maintenance records. ADs shown may apply; always confirm against your aircraft's official records.",
                "If you know of a part with an active AD that isn't listed here, please send us feedback so we can get it added for everyone. Thank you!",
              ]}
              forceOnce
              iconSize={fs(14)}
            />
          </View>
          {aircraft.nickname && <Text style={[styles.acSub, { color: tokens.t3, fontSize: fs(13) }]}>{aircraft.nickname}</Text>}
          {aircraft.type_designator && (
            <Text style={[styles.acSub, { color: tokens.t3, fontSize: fs(12) }]}>Type {aircraft.type_designator}</Text>
          )}
          {/* Self-reported hobbs/tach -- RC: "the field can default to a/c
              level," compared live against each reminder's own optional
              usage-based due mark below. Free-tier disclaimer already
              covers "based only on what you enter here." RC, on a first
              build with a pencil icon + "Set current hours" label: "we
              don't need those words. Just the icon and 'Set' - but make
              them blue so it's clear that they're clickable." Blue only
              when actually tappable (canEdit) -- a viewer sees the same
              value in the normal muted text color since tapping does
              nothing for them. */}
          {(aircraft.current_hobbs_hours != null || canEdit) && (
            <Pressable
              style={styles.hobbsRow}
              onPress={canEdit ? () => setHobbsModalVisible(true) : undefined}
              hitSlop={6}
            >
              <Icon name="speedometer" size={fs(12)} color={canEdit ? tokens.blu : tokens.t4} />
              <Text style={[styles.acSub, { color: canEdit ? tokens.blu : tokens.t3, fontSize: fs(12), marginBottom: 0 }]}>
                {aircraft.current_hobbs_hours != null ? `${aircraft.current_hobbs_hours}` : 'Set'}
              </Text>
            </Pressable>
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
                {/* RC: "we'll need an info icon somewhere explaining this"
                    -- once AD push alerts started fanning out to the whole
                    team (send-ad-alerts.mjs), this is the one place an
                    owner is already looking at exactly who's on that team. */}
                <InfoPopup
                  id="my-aircraft-collab-ad-push"
                  title="AD alerts go to everyone here"
                  body="When a new or updated AD matches this aircraft, everyone with access gets a push notification for it — not just you."
                  iconSize={fs(14)}
                />
              </View>
              {collaborators.map((c) => (
                <View key={c.userId} style={[styles.collabRow, { borderTopColor: tokens.bdr, opacity: c.accepted ? 1 : 0.5 }]}>
                  <Icon
                    name={c.accepted ? (c.lastViewedAt ? 'eye.fill' : 'eye.slash') : 'clock'}
                    size={fs(13)}
                    color={c.accepted ? (c.lastViewedAt ? tokens.grn : tokens.t4) : tokens.t4}
                  />
                  <Pressable
                    style={{ flex: 1 }}
                    onLongPress={(e) => showPreview(c.displayLabel, e)}
                    onPressOut={hidePreview}
                    delayLongPress={350}
                  >
                    <Text style={[styles.collabName, { color: c.accepted ? tokens.t1 : tokens.t3, fontSize: fs(13.5) }]} numberOfLines={1}>
                      {c.displayLabel}
                    </Text>
                  </Pressable>
                  {c.accepted ? (
                    // Tap-to-toggle, same interaction as folder/[id].tsx's
                    // own per-collaborator collabModeToggle -- this
                    // person's own access, independent of any other
                    // collaborator on the same aircraft.
                    <View style={[styles.roleToggle, { borderColor: tokens.bdr }]}>
                      <Pressable
                        style={[styles.roleToggleSeg, { backgroundColor: c.role === 'viewer' ? tokens.bdim : 'transparent' }]}
                        onPress={() => handleSetCollaboratorRole(c, 'viewer')}
                        hitSlop={4}
                      >
                        <Icon name="eye" size={fs(12)} color={c.role === 'viewer' ? tokens.blu : tokens.t4} />
                      </Pressable>
                      <Pressable
                        style={[styles.roleToggleSeg, { backgroundColor: c.role === 'editor' ? tokens.bdim : 'transparent' }]}
                        onPress={() => handleSetCollaboratorRole(c, 'editor')}
                        hitSlop={4}
                      >
                        <Icon name="pencil" size={fs(12)} color={c.role === 'editor' ? tokens.blu : tokens.t4} />
                      </Pressable>
                    </View>
                  ) : (
                    <View style={[styles.roleBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}>
                      <Text style={[styles.roleBadgeText, { color: tokens.t3, fontSize: fs(10) }]}>INVITED</Text>
                    </View>
                  )}
                  <Pressable onPress={() => handleRemoveCollaborator(c)} hitSlop={8}>
                    <Icon name="xmark.circle" size={fs(18)} color={tokens.t4} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

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
              {openAdCount > 0 && (
                <Text style={[styles.sectionCountBig, { color: tokens.t4, fontSize: fs(16) }]}>
                  {openAdCount}
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
            {/* RC: "on screen this looks okay, but on phone this area is
                still really cluttered. can we find a cleaner way to make
                use of all this info?" Three full rows of chrome (header,
                "Browse all", 4 filter pills) before the actual list even
                started -- each individually justified by an earlier round
                of feedback, but the sum read as heavy. "Browse all" folds
                into this header as an icon instead of its own row; the
                4 range pills become one compact pill below. Nothing here
                was removed, just given a smaller footprint. */}
            <Pressable onPress={() => router.push(`/ad?q=${encodeURIComponent(aircraft.make)}` as any)} hitSlop={10}>
              <Icon name="magnifyingglass" size={fs(17)} color={tokens.blu} />
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
              {adNotifications.length > 3 && (
                <Pressable
                  style={[styles.rangePill, styles.rangeDropdown, { borderColor: tokens.bdr }]}
                  hitSlop={10}
                  onPress={() => {
                    const ranges = Object.keys(AD_RANGE_LABELS) as AdRangeFilter[]
                    confirm({
                      title: 'Time range',
                      choices: ranges.map((r) => ({ label: AD_RANGE_LABELS[r], onPress: () => setAdRange(r) })),
                    })
                  }}
                >
                  <Text style={[styles.rangePillText, { color: tokens.t2, fontSize: fs(11.5) }]}>
                    {AD_RANGE_LABELS[adRange]}
                  </Text>
                  <Icon name="chevron.down" size={fs(10)} color={tokens.t3} />
                </Pressable>
              )}
              {adNotifications.length === 0 ? (
                <Text style={[styles.emptyHint, { color: tokens.t3, fontSize: fs(13), lineHeight: fs(13) * 1.38 }]}>
                  No Airworthiness Directives currently match this aircraft's make/model or tagged equipment. New or
                  existing ADs that apply will show up here automatically.
                </Text>
              ) : visibleAdNotifications.length === 0 ? (
                <Text style={[styles.emptyHint, { color: tokens.t3, fontSize: fs(13), lineHeight: fs(13) * 1.38 }]}>
                  No applicable ADs in the selected time range — widen the range above to see older ones.
                </Text>
              ) : (
                <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                  {/* RC: "get rid of all trash cans... in favor of swipe to
                      delete" + "don't need chevron since there's no
                      dropdown. just tap the bar to enter." handleDismissAd
                      already pops its own 2-step confirm dialog (unchanged
                      below), so the swipe reveal just needs to call it. */}
                  {visibleAdNotifications.map((n, i) => (
                    <View
                      key={n.id}
                      style={i < visibleAdNotifications.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }}
                    >
                      <SwipeToDelete
                        onDelete={() => handleDismissAd(n)}
                        onPress={() => {
                          if (consumeLongPress()) return
                          handleOpenAd(n)
                        }}
                        disabled={!canEdit}
                        leftAction={canEdit ? {
                          label: n.compliedAt ? 'Un-mark' : 'Mark',
                          color: tokens.blu,
                          onPress: () => (n.compliedAt ? handleUnmarkComplied(n) : handleMarkComplied(n)),
                        } : undefined}
                        // RC: "verify every reg list actually HAS the
                        // tap-hold feature" -- this Applicable ADs list had
                        // none despite subjectHeading being clipped to
                        // numberOfLines={2}, even though the "Link an AD"
                        // picker one modal over already had its own preview
                        // wired. Reuses this screen's one shared hook
                        // (already destructured above for the collaborator
                        // list) rather than standing up a second instance.
                        onLongPress={(e) => showPreview(n.subjectHeading, e, `AD ${n.adNumber}`)}
                        onPressOut={hidePreview}
                        delayLongPress={350}
                      >
                        <View style={[styles.row, { backgroundColor: tokens.bg2 }]}>
                          {!n.readAt && <View style={[styles.unreadDot, { backgroundColor: tokens.blu }]} />}
                          {/* Self-reported compliance record. RC: My
                              Aircraft (Pro) can have multiple ADs per
                              aircraft too, and should get the SAME
                              tap-chip-for-a-choice-sheet interaction the
                              Fleet list's chips have (my-aircraft/index.tsx's
                              handleQuickComplied) instead of jumping
                              straight to mark/un-mark with no "View
                              Details" alongside it -- byte-identical
                              interaction on both screens now. A checkmark
                              isn't FlyRegs asserting compliance, it's what
                              the owner/editor told it; handleMarkComplied's
                              own confirm carries that disclaimer every time. */}
                          <Pressable
                            onPress={(e) => {
                              e.stopPropagation()
                              if (!canEdit) return
                              confirm({
                                title: `AD ${n.adNumber}`,
                                choices: [
                                  { label: n.compliedAt ? 'Un-mark Complied' : 'Mark Complied', onPress: () => (n.compliedAt ? handleUnmarkComplied(n) : handleMarkComplied(n)) },
                                  { label: 'View AD Details', onPress: () => handleOpenAd(n) },
                                ],
                              })
                            }}
                            hitSlop={8}
                            disabled={!canEdit}
                          >
                            <Icon
                              name={n.compliedAt ? 'checkmark.circle.fill' : n.matchedVia === 'equipment' ? 'wrench' : 'airplane'}
                              size={fs(n.compliedAt ? 17 : 15)}
                              color={n.compliedAt ? tokens.grn : tokens.t3}
                            />
                          </Pressable>
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.rowTitle, { color: n.compliedAt ? tokens.t3 : tokens.blu, fontSize: fs(14) }]}>
                              AD {n.adNumber}
                            </Text>
                            <Text style={[styles.rowSub, { color: tokens.t2, fontSize: fs(12.5) }]} numberOfLines={2}>{n.subjectHeading}</Text>
                            {n.compliedAt ? (
                              <Text style={[styles.rowSub, { color: tokens.grn, fontSize: fs(11) }]}>
                                Complied {n.compliedAt.slice(0, 10)}
                              </Text>
                            ) : (
                              <Text style={[styles.rowSub, { color: tokens.t4, fontSize: fs(11) }]}>
                                {n.matchedVia === 'equipment' ? 'Equip Match' : 'Airframe Match'}
                                {n.citationPublishDate ? ` · ${n.citationPublishDate}` : ''}
                              </Text>
                            )}
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
              <Text style={[styles.emptyHint, { color: tokens.t3, fontSize: fs(13), lineHeight: fs(13) * 1.38 }]}>
                Tag a specific engine, prop, or avionics box so AD alerts also catch part-keyed ADs, not just ones for
                your airframe model.
              </Text>
            ) : (
              <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {equipment.map((e, i) => {
                  // Same severity vocabulary as the Reminders row below --
                  // a part's own tracking reads the same way a glance at
                  // a reminder does, since they're the same underlying
                  // concept (a date/hour compliance mark). Unlike Reminders
                  // (which always has a date and treats hobbs as bonus
                  // info layered onto that date's own color), a part here
                  // can be hobbs-ONLY with no date at all -- RC, real
                  // device: "I set a value for one... but I didn't see
                  // anything different" was this exact gap. hobbs needed
                  // its OWN full green/amber/red tier, not just a red
                  // override on top of a date color that might not exist.
                  const hobbsRemaining = e.dueHobbsHours != null && aircraft.current_hobbs_hours != null
                    ? e.dueHobbsHours - aircraft.current_hobbs_hours
                    : null
                  const hobbsOverdue = hobbsRemaining != null && hobbsRemaining < 0
                  // "Soon" is interval-relative (≤10% of the recurrence
                  // left) since a part's own interval can be anywhere from
                  // 25 to 2,000+ hours -- a flat hour cutoff wouldn't mean
                  // the same thing for both. Falls back to a flat 10hrs
                  // when there's no interval to scale against.
                  const hobbsSoon = hobbsRemaining != null && hobbsRemaining >= 0
                    && hobbsRemaining <= (e.intervalHours ? e.intervalHours * 0.1 : 10)
                  const hobbsColor = e.dueHobbsHours == null ? null : hobbsOverdue ? tokens.red : hobbsSoon ? tokens.amb : tokens.grn
                  const hobbsText = e.dueHobbsHours == null ? null : hobbsRemaining != null
                    ? (hobbsOverdue ? `OVERDUE by ${Math.abs(hobbsRemaining).toFixed(1)} hrs` : `Due in ${hobbsRemaining.toFixed(1)} hrs`)
                    : `Due at ${e.dueHobbsHours} hrs`
                  const dateDays = e.dueDate ? daysUntil(e.dueDate) : null
                  const dateOverdue = dateDays != null && dateDays < 0
                  const dateSoon = dateDays != null && dateDays >= 0 && dateDays <= 30
                  const dateColor = e.dueDate == null ? null : dateOverdue ? tokens.red : dateSoon ? tokens.amb : tokens.grn
                  const dateText = dateDays != null ? `${dateOverdue ? `${Math.abs(dateDays)}d overdue` : `${dateDays}d`} · ${e.dueDate}` : null
                  // Worse-of-the-two-axes wins the row's overall accent --
                  // red beats amber beats green beats "no tracking at all."
                  const rank = (c: string | null) => c === tokens.red ? 3 : c === tokens.amb ? 2 : c === tokens.grn ? 1 : 0
                  const trackColor = rank(hobbsColor) >= rank(dateColor) ? hobbsColor : dateColor
                  const anyOverdue = hobbsOverdue || dateOverdue
                  const trackingParts = [dateText, hobbsText].filter(Boolean)
                  return (
                    <View key={e.id} style={i < equipment.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }}>
                      <SwipeToDelete
                        onDelete={() => handleRemoveEquipment(e)}
                        onPress={canEdit ? () => openTrackEquipment(e) : undefined}
                        disabled={!canEdit}
                      >
                        <View style={[styles.row, { backgroundColor: tokens.bg2 }]}>
                          <Icon name="wrench" size={fs(15)} color={anyOverdue ? tokens.red : tokens.blu} />
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]}>{e.part.name}</Text>
                            {e.part.manufacturer && <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12) }]}>{e.part.manufacturer}</Text>}
                            {trackingParts.length > 0 && (
                              <Text style={[styles.rowSub, { color: trackColor ?? tokens.t3, fontSize: fs(12), fontWeight: '600' }]}>
                                {trackingParts.join(' · ')}
                              </Text>
                            )}
                          </View>
                        </View>
                      </SwipeToDelete>
                    </View>
                  )
                })}
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
              <Text style={[styles.emptyHint, { color: tokens.t3, fontSize: fs(13), lineHeight: fs(13) * 1.38 }]}>
                Add a due date for anything you want a nudge on — ELT battery, transponder check, annual, 100-hour, or
                a compliance part from an AD.
              </Text>
            ) : (
              <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {reminders.map((r, i) => {
                  const days = daysUntil(r.dueDate)
                  const overdue = days < 0
                  const soon = days >= 0 && days <= 30
                  // RC: "it's nice for these to be color coded as well.
                  // green when good, amber when w/n a certain number of
                  // days from due (maybe 30 days), and red when overdue."
                  // Same 3-color severity vocabulary as the Fleet ring
                  // above (not a 4th color like the gold this replaced),
                  // so a glance here reads the same way a glance at the
                  // ring does.
                  const dateColor = overdue ? tokens.red : soon ? tokens.amb : tokens.grn
                  // Live usage-based comparison -- only computable once the
                  // aircraft itself has a self-reported hours value; without
                  // one, fall back to just stating the due mark plainly.
                  const hobbsRemaining = r.dueHobbsHours != null && aircraft.current_hobbs_hours != null
                    ? r.dueHobbsHours - aircraft.current_hobbs_hours
                    : null
                  const hobbsOverdue = hobbsRemaining != null && hobbsRemaining < 0
                  // Same consistency fix as the Equipment row: hobbs used
                  // to only ever override to red-if-overdue, riding on
                  // whatever the DATE's color already was otherwise -- a
                  // hobbs-only reminder had no way to show its own
                  // amber/green. Reminders have no hours-based interval
                  // field of their own (only intervalMonths, a calendar
                  // recurrence), so this uses the same flat 10hr threshold
                  // Equipment's own hobbs tier falls back to when it has
                  // no interval to scale against -- one consistent
                  // threshold shared by both features now.
                  const hobbsSoon = hobbsRemaining != null && hobbsRemaining >= 0 && hobbsRemaining <= 10
                  const hobbsColor = r.dueHobbsHours == null ? null : hobbsOverdue ? tokens.red : hobbsSoon ? tokens.amb : tokens.grn
                  // Same wording as the Equipment row above -- RC: "not
                  // '100 left hrs' but say 'Due in 100.0 hrs'."
                  const hobbsText = r.dueHobbsHours == null ? '' : hobbsRemaining != null
                    ? ` · ${hobbsOverdue ? `OVERDUE by ${Math.abs(hobbsRemaining).toFixed(1)} hrs` : `Due in ${hobbsRemaining.toFixed(1)} hrs`}`
                    : ` · Due at ${r.dueHobbsHours} hrs`
                  // Worst-of-both-axes wins, same rank function as the
                  // Equipment row -- red beats amber beats green.
                  const rank = (c: string | null) => c === tokens.red ? 3 : c === tokens.amb ? 2 : c === tokens.grn ? 1 : 0
                  const color = rank(hobbsColor) >= rank(dateColor) ? (hobbsColor ?? dateColor) : dateColor
                  return (
                    <View key={r.id} style={i < reminders.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }}>
                      <SwipeToDelete
                        onDelete={() => handleRemoveReminder(r)}
                        onPress={canEdit ? () => openEditReminder(r) : undefined}
                        disabled={!canEdit}
                      >
                        <View style={[styles.row, { backgroundColor: tokens.bg2 }]}>
                          <Icon name="hourglass" size={fs(15)} color={color} />
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]}>{r.title}</Text>
                            <Text style={[styles.rowSub, { color, fontSize: fs(12) }]}>
                              {overdue ? `${Math.abs(days)}d` : `${days}d`} · {r.dueDate}
                              {r.linkedAdNumber ? ` · AD ${r.linkedAdNumber}` : ''}
                              {r.intervalMonths ? ` · every ${r.intervalMonths}mo` : ''}
                              {r.intervalDays ? ` · every ${r.intervalDays}d` : ''}
                              {hobbsText}
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
        editing={!!editingEquipment}
        onClose={() => { setPartPickerVisible(false); setEditingEquipment(null) }}
        onPicked={async (part) => {
          if (!aircraft) return
          if (editingEquipment) {
            // Swap which part this tag points to. No update-in-place
            // function exists for a part reference, so this is add-new
            // then remove-old -- tracking values reset blank on the new
            // part rather than carrying over, since a different part's own
            // interval rarely matches the old one's.
            //
            // Add BEFORE remove, and wrapped in try/catch: this used to
            // remove first, then add -- if the add failed (transient
            // network/RLS blip, the same failure shape as
            // gotcha_enablesync_unguarded_updateuser.md), the old tag
            // (its interval, due hobbs/date tracking) was already gone and
            // nothing replaced it, with no error shown anywhere -- the
            // modal just silently didn't close. Worst case now is a
            // harmless duplicate tag if the remove itself fails after a
            // successful add -- recoverable and visible, unlike losing the
            // tag outright.
            try {
              await addAircraftEquipment(aircraft.id, part.id)
              await removeAircraftEquipment(editingEquipment.id)
              setPartPickerVisible(false)
              setEditingEquipment(null)
              load()
              backfillAircraftAds(aircraft.id)
                .then((count) => { if (count > 0) getAircraftAdNotifications(aircraft.id).then(setAdNotifications) })
                .catch((e) => console.error('AD backfill failed for new equipment tag:', e?.message ?? e))
            } catch (e: any) {
              confirm({ title: 'Could not change part', message: e?.message ?? 'Unknown error -- your original part tag is untouched. Try again.', cancelLabel: null })
            }
          } else {
            // Brand new tag -- don't insert yet. RC: "each part box needs
            // an input sheet" for its own date/hour requirement, so the
            // tracking sheet is the next step, not an immediate insert.
            //
            // The other direction of changeEquipmentPart's round trip (see
            // its comment above for the full mechanism): this branch is
            // entirely synchronous -- unlike the editingEquipment branch
            // above, whose real addAircraftEquipment/removeAircraftEquipment
            // round trips give the dismiss time to land on their own -- so
            // closing THIS picker's <Modal> and setting PartTrackingModal's
            // own visible=true landed in the SAME commit, the identical
            // present-while-dismissing deadlock. Same setTimeout(..., 300)
            // deferral as every other close+open handoff in this file.
            setPartPickerVisible(false)
            setTimeout(() => setTrackingTarget({ mode: 'new', part }), 300)
          }
        }}
      />
      <PartTrackingModal
        visible={!!trackingTarget}
        part={trackingTarget?.mode === 'new' ? trackingTarget.part : trackingTarget?.equipment.part ?? null}
        initial={trackingTarget?.mode === 'edit' ? trackingTarget.equipment : null}
        currentHobbs={aircraft.current_hobbs_hours ?? null}
        canChangePart={trackingTarget?.mode === 'edit'}
        onClose={() => setTrackingTarget(null)}
        onChangePart={changeEquipmentPart}
        onSave={handleSaveTracking}
      />
      <ReminderFormModal
        visible={reminderFormVisible}
        editing={editingReminder}
        applicableAds={adNotifications}
        onClose={() => { setReminderFormVisible(false); setEditingReminder(null) }}
        onSaved={async ({ title, dueDate, notes, linkedAdNumber, intervalMonths, dueHobbsHours, intervalDays }) => {
          if (!aircraft || !session) return
          try {
            if (editingReminder) {
              await updateAircraftReminder(editingReminder.id, title, dueDate, linkedAdNumber, notes, intervalMonths, dueHobbsHours, intervalDays)
            } else {
              await addAircraftReminder(session.user.id, aircraft.id, title, dueDate, linkedAdNumber, notes, intervalMonths, dueHobbsHours, intervalDays)
            }
            setReminderFormVisible(false)
            setEditingReminder(null)
            load()
          } catch (e: any) {
            confirm({ title: 'Could not save reminder', message: e?.message ?? 'Unknown error', cancelLabel: null })
          }
        }}
      />
      <EditAircraftModal
        aircraft={editingAircraft}
        onClose={() => setEditingAircraft(null)}
        // A make/model/type_designator edit changes what this aircraft
        // actually IS, and those three fields are the whole input to the AD
        // match -- so the Applicable ADs list underneath is now describing a
        // different aircraft until it's re-derived. Nothing did that before:
        // a saved 172S corrected to a PA-28-181 kept all 13 of its Cessna
        // ADs and showed none of the Piper's, confirmed live. Fires only on
        // a real identity change (see EditAircraftModal's own prop doc), so
        // renaming a nickname or fixing a year still costs nothing.
        onSaved={(identityChanged) => {
          setEditingAircraft(null)
          if (!identityChanged) { load(); return }
          setBackfilling(true)
          resyncAircraftAds(aircraft.id)
            .catch((e) => { console.error('AD resync after aircraft edit failed:', e?.message ?? e) })
            .finally(() => { setBackfilling(false); load() })
        }}
      />
      <HobbsUpdateModal
        visible={hobbsModalVisible}
        aircraftId={aircraft.id}
        initialHours={aircraft.current_hobbs_hours ?? null}
        updatedAt={aircraft.hobbs_updated_at ?? null}
        onClose={() => setHobbsModalVisible(false)}
        onSaved={() => { setHobbsModalVisible(false); load() }}
      />
      <Modal visible={shareStep !== 'closed'} animationType="slide" transparent onRequestClose={closeShareModal}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
          {/* RC, real device: "move the whole 'invite' box up more off the
              bottom of the phone screen. it's so low it's getting buried and
              competing w/ the phone's slider bar down there." This card had
              no bottom safe-area padding at all -- on an iPhone with a home
              indicator, its last row (the Find Friends link) sat right in
              the gesture-bar's own hit zone. `insets.bottom` alone isn't
              enough breathing room on its own (it's sized for a hairline
              gesture bar, not a comfortable gap above it), so this adds a
              deliberate 16px on top of it. */}
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr, paddingBottom: insets.bottom + 16 }]}>
            {shareStep === 'role' ? (
              <>
                <View style={styles.modalHeader}>
                  <Pressable onPress={closeShareModal} hitSlop={10}>
                    <Text style={{ color: tokens.t3, fontSize: fs(14.5) }}>Cancel</Text>
                  </Pressable>
                  <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>Share this aircraft</Text>
                  <View style={{ width: 50 }} />
                </View>
                <Text style={{ color: tokens.t3, fontSize: fs(13) }}>
                  Invite by Callsign. They'll need their own Premium subscription and a Callsign set to join.
                </Text>
                <Pressable
                  onPress={() => pickRole('viewer')}
                  style={[styles.shareRoleBtn, { backgroundColor: tokens.blu }]}
                >
                  <Text style={styles.shareRoleBtnText}>Invite as Viewer</Text>
                </Pressable>
                <Pressable
                  onPress={() => pickRole('editor')}
                  style={[styles.shareRoleBtn, { backgroundColor: tokens.blu }]}
                >
                  <Text style={styles.shareRoleBtnText}>Invite as Editor</Text>
                </Pressable>
              </>
            ) : shareStep === 'findFriends' ? (
              // Bounded so a long contact match list scrolls WITHIN the
              // card instead of growing it past the screen -- modalCard
              // itself has no height cap since every other step's content
              // is short and fixed.
              <View style={{ maxHeight: 420 }}>
                <FindFriendsPickerBody
                  onClose={() => setShareStep('callsign')}
                  onSelect={(callsign) => { setInviteCallsign(callsign); setInviteError(null); setShareStep('callsign') }}
                />
              </View>
            ) : (
              <>
                <View style={styles.modalHeader}>
                  <Pressable onPress={closeShareModal} hitSlop={10}>
                    <Text style={{ color: tokens.t3, fontSize: fs(14.5) }}>Cancel</Text>
                  </Pressable>
                  <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>
                    Invite as {inviteRole === 'editor' ? 'Editor' : 'Viewer'}
                  </Text>
                  <Pressable onPress={submitInvite} hitSlop={10} disabled={sharingBusy || callsignCheck !== 'found'}>
                    {sharingBusy ? <ActivityIndicator color={tokens.blu} /> : (
                      <Text style={{ color: callsignCheck === 'found' ? tokens.blu : tokens.t4, fontWeight: '700', fontSize: fs(14.5) }}>Invite</Text>
                    )}
                  </Pressable>
                </View>
                <Text style={{ color: tokens.t3, fontSize: fs(13) }}>
                  Their Callsign, exactly as it appears in FlyRegs.
                </Text>
                <TextInput
                  value={inviteCallsign}
                  onChangeText={setInviteCallsign}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Callsign"
                  placeholderTextColor={tokens.t4}
                  style={[styles.inviteInput, { color: tokens.t1, borderColor: inviteError || callsignCheck === 'not_found' ? tokens.red : tokens.bdr, fontSize: ifs(15) }]}
                />
                {callsignCheck === 'checking' && <Text style={{ color: tokens.t3, fontSize: fs(12.5) }}>Checking…</Text>}
                {callsignCheck === 'found' && <Text style={{ color: tokens.grn, fontSize: fs(12.5) }}>Callsign found</Text>}
                {callsignCheck === 'not_found' && <Text style={{ color: tokens.red, fontSize: fs(12.5) }}>No FlyRegs user with this Callsign</Text>}
                {inviteError && <Text style={{ color: tokens.red, fontSize: fs(12.5) }}>{inviteError}</Text>}
                <Pressable
                  style={styles.findFriendsLink}
                  hitSlop={10}
                  onPress={() => { Keyboard.dismiss(); setShareStep('findFriends') }}
                >
                  <Icon name="person.2.fill" size={fs(13)} color={tokens.blu} />
                  <Text style={{ color: tokens.blu, fontSize: fs(12.5), fontWeight: '600' }}>Find Friends from Contacts</Text>
                </Pressable>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <BulkInviteContactPicker
        visible={bulkInviteVisible}
        onClose={() => setBulkInviteVisible(false)}
        message={bulkInviteTokenRef.current ? buildAircraftShareLink(bulkInviteTokenRef.current) : ''}
        onSent={handleBulkInviteSent}
      />
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

function PartPickerModal({ visible, editing, onClose, onPicked }: { visible: boolean; editing?: boolean; onClose: () => void; onPicked: (p: AdPart) => void }) {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
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
        <OverlayHeader title={editing ? 'Change Equipment' : 'Add Equipment'} onBack={onClose} />
        <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
          <TextInput
            style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(14) }]}
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
                <Text style={[styles.relatedNoteText, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]}>
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

// RC: "each part box needs an input sheet" -- when a part like a 100-hour
// item is tagged, the owner needs to say how often it recurs and get that
// tracked by tach hours, by calendar date, or both. Mirrors
// ReminderFormModal's own due-date/due-hobbs shape and its nested
// DatePickerModal reset-on-every-visibility-change discipline (see that
// component's comment for the real freeze this prevents), but scoped to
// ONE part instead of a freeform reminder list entry.
function PartTrackingModal({
  visible, part, initial, currentHobbs, canChangePart, onClose, onChangePart, onSave,
}: {
  visible: boolean
  part: AdPart | null
  initial: PartTracking | null
  currentHobbs: number | null
  canChangePart: boolean
  onClose: () => void
  onChangePart: () => void
  onSave: (tracking: PartTracking) => void | Promise<void>
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const insets = useSafeAreaInsets()
  const [intervalText, setIntervalText] = useState('')
  const [dueHobbsText, setDueHobbsText] = useState('')
  // Tracks whether the owner has typed into the due-hobbs field directly
  // this session -- until they do, it auto-follows the interval field
  // (RC: "tach tracking can happen automatically based on the current
  // time of their a/c when the part is added"). Typing over the
  // auto-filled value IS the "custom start point" override RC also asked
  // for -- no separate toggle needed, just stop auto-following once
  // they've touched it themselves.
  const [dueHobbsTouched, setDueHobbsTouched] = useState(false)
  const [dueDate, setDueDate] = useState('')
  const [datePickerVisible, setDatePickerVisible] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDatePickerVisible(false)
    if (!visible) return
    setIntervalText(initial?.intervalHours != null ? String(initial.intervalHours) : '')
    setDueHobbsText(initial?.dueHobbsHours != null ? String(initial.dueHobbsHours) : '')
    setDueHobbsTouched(false)
    setDueDate(initial?.dueDate ?? '')
    setSaving(false)
  }, [visible, initial])

  const applyInterval = (text: string) => {
    const digitsOnly = text.replace(/[^0-9.]/g, '')
    setIntervalText(digitsOnly)
    if (dueHobbsTouched) return
    const n = parseFloat(digitsOnly)
    if (!digitsOnly || isNaN(n) || currentHobbs == null) { setDueHobbsText(''); return }
    setDueHobbsText(String(Math.round((currentHobbs + n) * 10) / 10))
  }

  const applyDueHobbs = (text: string) => {
    setDueHobbsTouched(true)
    setDueHobbsText(text.replace(/[^0-9.]/g, ''))
  }

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    const intervalHours = intervalText.trim() ? parseFloat(intervalText.trim()) : null
    const dueHobbsHours = dueHobbsText.trim() ? parseFloat(dueHobbsText.trim()) : null
    // try/finally, same shape as ReminderFormModal.handleSave -- this used
    // to have neither: a thrown save (e.g. a transient network/RLS blip)
    // left `saving` stuck true forever, so the Save button stayed disabled
    // with its spinner showing and the modal never closed, with no error
    // shown anywhere -- the only way out was abandoning via the X. Error
    // surfacing itself is onSave's (the parent's) job, matching every
    // other save handler on this screen.
    try {
      await onSave({ intervalHours, dueHobbsHours, dueDate: dueDate.trim() || null })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalBackdrop}>
          {/* RC, real device: this card has more stacked fields than any
              other bottom sheet in the file (interval, due-hobbs, an
              optional warning line, due-date, Change Part) -- tall enough
              that once the decimal-pad keyboard is up, KeyboardAvoidingView
              had nowhere left to push it and the whole card got squeezed
              flush against the top of the screen, cutting the header off.
              A capped maxHeight + inner ScrollView (same shape as the
              AD-link picker's own scrollable list below) lets the content
              scroll instead of the card being forced to fit in full. */}
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr, maxHeight: '85%', paddingBottom: Math.max(18, insets.bottom + 8) }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]} numberOfLines={1}>
                Track {part?.name ?? 'Part'}
              </Text>
              <Pressable onPress={onClose} hitSlop={10}>
                <Icon name="xmark" size={fs(18)} color={tokens.t3} />
              </Pressable>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10 }}>
              <Text style={{ color: tokens.t3, fontSize: fs(13) }}>
                How often does this part need inspection or replacement? Leave blank if it's just tagged for AD
                matching.
              </Text>

              <Text style={[styles.formLabel, { color: tokens.t3, fontSize: fs(11) }]}>EVERY (HOURS)</Text>
              <View style={[styles.formInput, styles.dateField, { borderColor: tokens.bdr, paddingVertical: 0 }]}>
                <TextInput
                  value={intervalText}
                  onChangeText={applyInterval}
                  placeholder="e.g. 100"
                  placeholderTextColor={tokens.t3}
                  keyboardType="decimal-pad"
                  style={{ flex: 1, color: tokens.t1, fontSize: ifs(14.5), paddingVertical: 12 }}
                />
                <Text style={{ color: tokens.t3, fontSize: fs(13) }}>hrs</Text>
              </View>

              <Text style={[styles.formLabel, { color: tokens.t3, fontSize: fs(11) }]}>DUE AT (TACH HOURS)</Text>
              <View style={[styles.formInput, styles.dateField, { borderColor: tokens.bdr, paddingVertical: 0 }]}>
                <TextInput
                  value={dueHobbsText}
                  onChangeText={applyDueHobbs}
                  placeholder={currentHobbs != null ? 'auto: current + interval' : 'e.g. 1594.7'}
                  placeholderTextColor={tokens.t3}
                  keyboardType="decimal-pad"
                  style={{ flex: 1, color: tokens.t1, fontSize: ifs(14.5), paddingVertical: 12 }}
                />
                <Text style={{ color: tokens.t3, fontSize: fs(13) }}>hrs</Text>
              </View>
              {currentHobbs == null && intervalText.trim() !== '' && (
                <Text style={{ color: tokens.amb, fontSize: fs(12) }}>
                  No current tach reading on file for this aircraft yet -- enter a due value directly, or set one
                  from My Fleet first.
                </Text>
              )}

              <Text style={[styles.formLabel, { color: tokens.t3, fontSize: fs(11) }]}>DUE DATE (OPTIONAL)</Text>
              <Pressable style={[styles.formInput, styles.dateField, { borderColor: tokens.bdr }]} onPress={() => setDatePickerVisible(true)}>
                <Text style={{ color: dueDate ? tokens.t1 : tokens.t3, fontSize: fs(14.5) }}>{dueDate || 'No due date'}</Text>
                <Icon name="chevron.down" size={fs(14)} color={tokens.t4} />
              </Pressable>
              {dueDate !== '' && (
                <Pressable onPress={() => setDueDate('')} hitSlop={8}>
                  <Text style={{ color: tokens.t3, fontSize: fs(12.5) }}>Clear due date</Text>
                </Pressable>
              )}

              {canChangePart && (
                <Pressable onPress={onChangePart} hitSlop={8}>
                  <Text style={{ color: tokens.blu, fontSize: fs(13), fontWeight: '600' }}>Change Part</Text>
                </Pressable>
              )}

              <Pressable style={[styles.addButton, { backgroundColor: tokens.blu }]} onPress={handleSave} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" /> : (
                  <Text style={[styles.addButtonText, { fontSize: fs(14.5) }]}>Save</Text>
                )}
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
        {/* Child of THIS Modal, not a sibling after it -- see
            DatePickerModal's own comment for why nesting a second <Modal>
            broke the Pressable that opens it. */}
        <DatePickerModal
          visible={datePickerVisible}
          initialDate={dueDate}
          onClose={() => setDatePickerVisible(false)}
          onSelect={setDueDate}
          tokens={tokens}
          fs={fs}
        />
      </Modal>
    </>
  )
}

// Redesigned add/edit form (RC: scope the Reminders work, then "which
// schema is more flexible and easy to use for the user? ... they should
// still be able to manually adjust a date if needed"). Type chips only
// show in ADD mode -- picking one is a one-time shortcut that fills
// title+date, not a persisted category, so re-showing chips in EDIT mode
// would imply a selection state that doesn't exist once a reminder is
// saved. The LENGTH row below (interval_months) is different -- it IS
// persisted (see migrations_reminder_interval.sql) and shown/editable in
// BOTH modes per RC: "these reminder boxes need to also show the selected
// length of the reminder (12mo, 24mo, etc) and they all also have to have
// that bar be editable with a custom length."
function ReminderFormModal({
  visible, editing, applicableAds, onClose, onSaved,
}: {
  visible: boolean
  editing: AircraftReminder | null
  applicableAds: AircraftAdNotification[]
  onClose: () => void
  onSaved: (input: { title: string; dueDate: string; notes: string; linkedAdNumber: string | null; intervalMonths: number | null; intervalDays: number | null; dueHobbsHours: number | null }) => Promise<void>
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const confirm = useConfirm()
  const insets = useSafeAreaInsets()
  const [typeKey, setTypeKey] = useState<ReminderTypeKey | null>(null)
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [linkedAdNumber, setLinkedAdNumber] = useState<string | null>(null)
  const [intervalMonths, setIntervalMonths] = useState<number | null>(null)
  // Which unit the LENGTH bar below is currently editing -- follows the
  // selected TYPE chip (VOR Check -> days, everything else -> months) in
  // ADD mode, or whichever field an existing reminder actually has set in
  // EDIT mode. No separate unit toggle control: every type has one natural
  // unit, so switching types (or loading an existing reminder) is the only
  // way this changes -- matches RC's "flexible... but still simple" framing
  // without adding UI surface beyond the 2 new chips he asked for.
  const [intervalDays, setIntervalDays] = useState<number | null>(null)
  const [lengthUnit, setLengthUnit] = useState<'months' | 'days'>('months')
  const [customLengthText, setCustomLengthText] = useState('')
  const [dueHobbsText, setDueHobbsText] = useState('')
  const [datePickerVisible, setDatePickerVisible] = useState(false)
  const [adPickerVisible, setAdPickerVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  // AD subject headings in the "link an AD" picker below can run long and
  // get cut off the same way FAR Part titles do -- same hook/card pair as
  // far/index.tsx's own long-press preview. Self-contained here (not
  // threaded from the parent screen) since this modal is its own
  // self-fetching, self-contained unit.
  const { preview: adPickerPreview, previewHeight: adPickerPreviewHeight, setPreviewHeight: setAdPickerPreviewHeight, showPreview: showAdPickerPreview, hidePreview: hideAdPickerPreview, consumeLongPress: consumeAdPickerLongPress } = useLongPressPreview()

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
    setSaving(false)
    if (!visible) return
    setTypeKey(null)
    setTitle(editing?.title ?? '')
    setDueDate(editing?.dueDate ?? '')
    setNotes(editing?.notes ?? '')
    setLinkedAdNumber(editing?.linkedAdNumber ?? null)
    const im = editing?.intervalMonths ?? null
    const idays = editing?.intervalDays ?? null
    setIntervalMonths(im)
    setIntervalDays(idays)
    setLengthUnit(idays != null ? 'days' : 'months')
    setCustomLengthText(
      idays != null && !(DAY_LENGTH_PRESETS as readonly number[]).includes(idays) ? String(idays)
        : im != null && !(LENGTH_PRESETS as readonly number[]).includes(im) ? String(im)
          : ''
    )
    setDueHobbsText(editing?.dueHobbsHours != null ? String(editing.dueHobbsHours) : '')
  }, [visible, editing])

  const selectType = (key: ReminderTypeKey) => {
    setTypeKey(key)
    const def = REMINDER_TYPES.find((t) => t.key === key)!
    setTitle(def.defaultTitle)
    setCustomLengthText('')
    if (def.days != null) {
      setDueDate(toISODate(addDays(new Date(), def.days)))
      setLengthUnit('days')
      setIntervalDays(def.days)
      setIntervalMonths(null)
    } else {
      setDueDate(def.months != null ? toISODate(addMonths(new Date(), def.months)) : '')
      setLengthUnit('months')
      setIntervalMonths(def.months)
      setIntervalDays(null)
    }
    if (key !== 'ad') setLinkedAdNumber(null)
  }

  const handleSave = async () => {
    // Real device beta report (BB-070/BB-094): this screen "fully froze,
    // locked up" trying to save a reminder. No busy-state guard on Save
    // meant a slow network round-trip plus an impatient second tap (the
    // exact "many movements and button clicks happen quickly" pattern RC
    // flagged app-wide) could fire two concurrent saves racing each other.
    // Now the button disables itself and shows a spinner the instant the
    // real save starts, and can't be tapped again until it actually
    // resolves either way.
    if (saving) return
    if (!title.trim()) { confirm({ title: 'Title required', message: 'Enter what this reminder is for.', cancelLabel: null }); return }
    if (!DATE_RE.test(dueDate.trim())) { confirm({ title: 'Pick a due date', message: 'Use the date picker to set when this is due.', cancelLabel: null }); return }
    const dueHobbsHours = dueHobbsText.trim() ? parseFloat(dueHobbsText.trim()) : null
    setSaving(true)
    try {
      await onSaved({ title: title.trim(), dueDate: dueDate.trim(), notes, linkedAdNumber, intervalMonths, intervalDays, dueHobbsHours })
    } finally {
      setSaving(false)
    }
  }

  const lengthPresets = lengthUnit === 'days' ? DAY_LENGTH_PRESETS : LENGTH_PRESETS
  const activeIntervalValue = lengthUnit === 'days' ? intervalDays : intervalMonths
  const isCustomLength = customLengthText !== '' || (activeIntervalValue != null && !(lengthPresets as readonly number[]).includes(activeIntervalValue))
  const selectPresetLength = (n: number | null) => {
    if (lengthUnit === 'days') { setIntervalDays(n); setIntervalMonths(null) } else { setIntervalMonths(n); setIntervalDays(null) }
    setCustomLengthText('')
  }
  const selectCustomLength = (text: string) => {
    const digitsOnly = text.replace(/[^0-9]/g, '')
    setCustomLengthText(digitsOnly)
    const n = parseInt(digitsOnly, 10)
    const val = digitsOnly && n > 0 ? n : null
    if (lengthUnit === 'days') { setIntervalDays(val); setIntervalMonths(null) } else { setIntervalMonths(val); setIntervalDays(null) }
  }

  return (
    <>
      <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
        {/* RC, real device: the tach/hobbs decimal-pad keypad (and the
            title/notes fields' own keypads) covered the input box AND the
            Save button, same root cause as HobbsUpdateModal.tsx -- this
            bottom-sheet's content never shifted up without
            KeyboardAvoidingView. Matches FolderPicker.tsx's own wrapper for
            the identical shape. */}
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalBackdrop}>
          {/* maxHeight + inner ScrollView (not a fixed-height View) --
              real device beta report (BB-070/BB-094): this whole form is
              taller than one screen once AD Compliance/a linked AD/custom
              length are all showing, and larger text-size settings make it
              worse. Previously nothing scrolled, so on a real device the
              Save button (and the fields above it) could end up
              unreachable -- looking exactly like a frozen screen. Save
              stays pinned outside the ScrollView so it's always reachable
              regardless of scroll position or text size. */}
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr, maxHeight: '90%', paddingBottom: Math.max(18, insets.bottom + 8) }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>{editing ? 'Edit Reminder' : 'New Reminder'}</Text>
              <Pressable onPress={onClose} hitSlop={10}>
                <Icon name="xmark" size={fs(18)} color={tokens.t3} />
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>

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
              style={[styles.formInput, { color: tokens.t1, fontSize: ifs(14.5), borderColor: tokens.bdr }]}
            />

            <Pressable style={[styles.formInput, styles.dateField, { borderColor: tokens.bdr }]} onPress={() => setDatePickerVisible(true)}>
              <Text style={{ color: dueDate ? tokens.t1 : tokens.t3, fontSize: fs(14.5) }}>{dueDate || 'Due date'}</Text>
              <Icon name="chevron.down" size={fs(14)} color={tokens.t4} />
            </Pressable>

            <Text style={[styles.formLabel, { color: tokens.t3, fontSize: fs(11) }]}>LENGTH (RECURS EVERY)</Text>
            <View style={styles.chipGrid}>
              <Pressable
                style={[styles.typeChip, { backgroundColor: activeIntervalValue == null && !isCustomLength ? tokens.bdim : tokens.bg2, borderColor: activeIntervalValue == null && !isCustomLength ? tokens.blu : tokens.bdr }]}
                onPress={() => selectPresetLength(null)}
              >
                <Text style={[styles.typeChipText, { color: activeIntervalValue == null && !isCustomLength ? tokens.blu : tokens.t1, fontSize: fs(12.5) }]}>None</Text>
              </Pressable>
              {lengthPresets.map((n) => {
                const active = activeIntervalValue === n && !isCustomLength
                return (
                  <Pressable
                    key={n}
                    style={[styles.typeChip, { backgroundColor: active ? tokens.bdim : tokens.bg2, borderColor: active ? tokens.blu : tokens.bdr }]}
                    onPress={() => selectPresetLength(n)}
                  >
                    <Text style={[styles.typeChipText, { color: active ? tokens.blu : tokens.t1, fontSize: fs(12.5) }]}>{n}{lengthUnit === 'days' ? 'd' : 'mo'}</Text>
                  </Pressable>
                )
              })}
              <Pressable
                style={[styles.typeChip, { backgroundColor: isCustomLength ? tokens.bdim : tokens.bg2, borderColor: isCustomLength ? tokens.blu : tokens.bdr }]}
                onPress={() => setCustomLengthText(activeIntervalValue != null ? String(activeIntervalValue) : '')}
              >
                <Text style={[styles.typeChipText, { color: isCustomLength ? tokens.blu : tokens.t1, fontSize: fs(12.5) }]}>Custom</Text>
              </Pressable>
            </View>
            {isCustomLength && (
              <View style={[styles.formInput, styles.dateField, { borderColor: tokens.bdr, paddingVertical: 0 }]}>
                <TextInput
                  value={customLengthText}
                  onChangeText={selectCustomLength}
                  placeholder={lengthUnit === 'days' ? 'Days' : 'Months'}
                  placeholderTextColor={tokens.t3}
                  keyboardType="number-pad"
                  style={{ flex: 1, color: tokens.t1, fontSize: ifs(14.5), paddingVertical: 12 }}
                />
                <Text style={{ color: tokens.t3, fontSize: fs(13) }}>{lengthUnit === 'days' ? 'days' : 'months'}</Text>
              </View>
            )}

            {/* RC: "here, we also need a box to input an a/c's 'tach' time.
                this is a user custom field - for things like 100 hour, which
                aren't based on a date, but on usage." Not restricted to the
                100-Hour type -- any reminder can carry a usage-based due
                mark alongside its date. Compared live against the
                aircraft's own self-reported current hours on the row below. */}
            <View style={[styles.formInput, styles.dateField, { borderColor: tokens.bdr, paddingVertical: 0 }]}>
              <TextInput
                value={dueHobbsText}
                onChangeText={(t) => setDueHobbsText(t.replace(/[^0-9.]/g, ''))}
                placeholder="Tach/Hobbs hours due (optional)"
                placeholderTextColor={tokens.t3}
                keyboardType="decimal-pad"
                style={{ flex: 1, color: tokens.t1, fontSize: ifs(14.5), paddingVertical: 12 }}
              />
              {dueHobbsText !== '' && <Text style={{ color: tokens.t3, fontSize: fs(13) }}>hrs</Text>}
            </View>

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
              style={[styles.formInput, { color: tokens.t1, fontSize: ifs(14.5), borderColor: tokens.bdr }]}
            />
            </ScrollView>

            <Pressable style={[styles.addButton, { backgroundColor: tokens.blu, opacity: saving ? 0.6 : 1, marginTop: 10 }]} onPress={handleSave} disabled={saving}>
              {saving
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={[styles.addButtonText, { fontSize: fs(14.5) }]}>{editing ? 'Save Changes' : 'Save Reminder'}</Text>}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
        {/* Child of THIS Modal, not a sibling after it -- see
            DatePickerModal's own comment for why nesting a second <Modal>
            broke the Pressable that opens it. */}
        <DatePickerModal
          visible={datePickerVisible}
          initialDate={dueDate}
          onClose={() => setDatePickerVisible(false)}
          onSelect={setDueDate}
          tokens={tokens}
          fs={fs}
        />
      </Modal>

      <Modal visible={adPickerVisible} animationType="slide" transparent onRequestClose={() => setAdPickerVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr, maxHeight: '70%', paddingBottom: Math.max(18, insets.bottom + 8) }]}>
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
                    onPress={() => {
                      if (consumeAdPickerLongPress()) return
                      setLinkedAdNumber(ad.adNumber); setAdPickerVisible(false)
                    }}
                    onLongPress={(e) => showAdPickerPreview(ad.subjectHeading, e)}
                    onPressOut={hideAdPickerPreview}
                    delayLongPress={350}
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
        <LongPressPreviewCard
          preview={adPickerPreview}
          previewHeight={adPickerPreviewHeight}
          onLayoutHeight={setAdPickerPreviewHeight}
          onDismiss={hideAdPickerPreview}
        />
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
  const insets = useSafeAreaInsets()
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

  // RC, real device (reproduced twice): "Due Date does not function. no tap
  // response at all" -- everything else in the same form works. Root cause:
  // this used to be its own <Modal>, rendered as a JSX SIBLING of the
  // parent form's <Modal> (both PartTrackingModal and ReminderFormModal
  // call it that way). React Native's <Modal> renders into a separate
  // native layer regardless of where it sits in the JSX tree, so having a
  // second <Modal> mounted at all -- even permanently visible=false --
  // is a known iOS touch-interception hazard for the one Pressable whose
  // whole job is to reveal it (nothing else in the form goes anywhere near
  // a second Modal, which is exactly the "only Due Date is dead" symptom).
  // Fixed by dropping the nested <Modal> entirely: this is now a plain
  // absolutely-positioned overlay, and both call sites now render it as a
  // CHILD inside their own single <Modal> instead of a sibling after it --
  // one real native modal layer, this just stacks on top within it.
  if (!visible) return null
  return (
    <View style={styles.datePickerOverlay}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr, paddingBottom: Math.max(18, insets.bottom + 8) }]}>
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
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  heroImage: { width: '100%', height: 200, borderRadius: 14, marginBottom: 14 },
  heroImageOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  heroPlaceholder: {
    width: '100%', height: 140, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 14,
  },
  heroPlaceholderText: { fontWeight: '600' },
  relatedNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7,
    borderRadius: 10, borderWidth: 1, padding: 10, marginBottom: 10,
  },
  // lineHeight NOT set here -- always overridden inline with fs(12.5) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  relatedNoteText: { flex: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  acLineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  acLine: { fontWeight: '700' },
  acSub: { marginTop: 2, marginBottom: 4 },
  hobbsRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4, alignSelf: 'flex-start' },
  leaveText: { fontWeight: '600' },
  roleBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  roleBadgeText: { fontWeight: '700', letterSpacing: 0.4 },
  roleToggle: { flexDirection: 'row', alignItems: 'center', borderRadius: 8, borderWidth: 1, overflow: 'hidden' },
  roleToggleSeg: { paddingHorizontal: 8, paddingVertical: 5 },
  collabSection: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', marginTop: 10, marginBottom: 4 },
  collabHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  collabHeaderText: { flex: 1, fontWeight: '600' },
  collabRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  collabName: { flex: 1 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, marginTop: 16, marginBottom: 8 },
  sectionTitleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5 },
  sectionCountBig: { fontWeight: '700' },
  // lineHeight NOT set here -- always overridden inline with fs(13) * 1.38
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  emptyHint: { marginBottom: 4 },
  rangePill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, borderWidth: 1 },
  rangeDropdown: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginBottom: 10 },
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
  // DatePickerModal's own full-screen overlay -- see its own comment for
  // why this is a plain View instead of a second nested <Modal>.
  datePickerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, elevation: 1000 },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, gap: 10 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  modalTitle: { fontWeight: '700' },
  inviteInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontWeight: '600' },
  findFriendsLink: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 4, paddingVertical: 6 },
  shareRoleBtn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  shareRoleBtnText: { color: '#fff', fontWeight: '700' },
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
