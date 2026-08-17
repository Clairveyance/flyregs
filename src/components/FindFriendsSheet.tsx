import { useEffect, useMemo, useState } from 'react'
import { View, Text, Modal, Pressable, TextInput, SectionList, FlatList, StyleSheet, ActivityIndicator, Platform, Share } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { getDeviceContacts, matchContactsToCallsigns, requestContactsPermission, presentContactsAccessPicker, resolveCallsignToUserId, getVisibleUsers, DeviceContact, VisibleUser } from '@/lib/contactMatch'
import { APP_NAME, APP_STORE_URL } from '@/lib/appInfo'

// RC: "build out the rest of the contact/invite path, RR, etc." -- the UI
// layer for src/lib/contactMatch.ts's core (privacy-preserving contact
// hashing, built earlier this session). Sibling to BulkInviteContactPicker
// (which sends SMS invites to contacts NOT yet on FlyRegs by phone number)
// but the inverse job: show which of the user's REAL contacts are already
// on FlyRegs, by their real callsign, so the caller can invite/view them
// directly instead of needing to already know their exact Callsign.
//
// RC, real device, after the first version (a silent email-only
// background match with no visible contact list): "this doesn't DO
// anything. This is a contact search area. it needs to 'connect' to and
// bring up my iOS phone contact book so i can add person/people to this
// invite. w/o that, it's useless." Rebuilt to show the user's REAL,
// searchable contact list (same proven load pattern as
// BulkInviteContactPicker.tsx) instead of a flat, unattributed, often-
// empty list of matches -- contacts already on FlyRegs are tappable and
// fill the Callsign field directly; contacts not yet on FlyRegs get an
// honest "Invite to FlyRegs" action (a generic App Store link via the
// native share sheet) since there's no Callsign to actually add them to
// THIS specific invite with yet.
//
// Native-only (expo-contacts has no web implementation) -- guarded up
// front so this never even attempts the native call in the browser
// preview, where it can't be verified anyway. RC tests the real device
// flow on their own phone dev build.
// The picker's actual header+list content, with no <Modal> of its own --
// pulled out so a caller that ALREADY has its own <Modal> open (aircraft
// and folder invite flows both do) can render this as another step inside
// THAT modal instead of stacking a second native <Modal>. Two RN <Modal>s
// both wanting to be visible at once is the exact iOS presentation deadlock
// my-aircraft/[id].tsx's shareStep comment already documents for the
// role/callsign steps -- this component reintroduced the same bug the
// first time it shipped as its own always-separate Modal (RC, real device:
// "find friends doesn't do anyting. won't tap" / "tapping FF just hides
// the k/b and drops the whole box back to the bottom, but nothing at all
// happens w/ FF" -- the keyboard-dismiss and layout collapse were real,
// the second Modal simply never visually presented over the first).
export function FindFriendsPickerBody({
  onClose,
  onSelect,
}: {
  onClose: () => void
  onSelect: (callsign: string) => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const [state, setState] = useState<'loading' | 'denied' | 'error' | 'ready'>('loading')
  const [contacts, setContacts] = useState<DeviceContact[]>([])
  const [matched, setMatched] = useState<Map<string, string>>(new Map())
  const [query, setQuery] = useState('')
  // Surfaced only in the error state's copy (dev builds) -- RC, real
  // device: "i get a RN error pop up screen then it just freezes." A
  // single trailing .catch() on the whole async chain still lets whatever
  // actually threw reach RN's own dev-mode error overlay before this
  // component's own catch runs (native module init failures in
  // particular can log/surface before the JS promise even settles) --
  // wrapping EVERY native call in its own try/catch, and logging exactly
  // what failed, closes that gap AND gives a real error message to go on
  // instead of guessing at the root cause blind next time.
  const [debugError, setDebugError] = useState<string | null>(null)
  // iOS 18+ Limited Access -- requestContactsPermission resolves granted:
  // true even when the user only shared a few (or zero) contacts, which
  // otherwise looks identical to "you genuinely have no contacts." See
  // BulkInviteContactPicker.tsx's identical fix for the full mechanism.
  const [limitedAccess, setLimitedAccess] = useState(false)
  // RC, real device: "the RR FF icon just brings up an empty box 'no
  // contacts found' and gives no options to search for or actually FIND a
  // friend." A device's contact book can legitimately come back empty (or
  // permission can be denied, or the native call can fail) -- none of that
  // should be a dead end for "find a specific person," since every other
  // invite flow in this app (aircraft, folder, New Duel) already has a
  // manual Callsign search that works independent of contacts. Same
  // debounced validate-as-you-type pattern as those, reused here rather
  // than re-derived -- see challenges/index.tsx's own identical block.
  const [manualCallsign, setManualCallsign] = useState('')
  const [manualCheck, setManualCheck] = useState<'idle' | 'checking' | 'found' | 'not_found'>('idle')

  // RC: "if all 'visible' users show up in RR, then that should be
  // another way of searching/finding someone - so, along w/ 'search
  // callsign' we should have the ability to scroll the RR list for
  // people." Independent of the contacts flow above (works on web, and
  // doesn't need contacts permission) -- everyone who's opted into
  // "Show me on the Ready Room leaderboard," scrollable right next to the
  // Callsign search box instead of requiring you to already know exactly
  // who you're looking for.
  const [visibleUsers, setVisibleUsers] = useState<VisibleUser[]>([])
  const [visibleUsersLoading, setVisibleUsersLoading] = useState(true)
  useEffect(() => {
    getVisibleUsers()
      .then(setVisibleUsers)
      .catch(() => setVisibleUsers([]))
      .finally(() => setVisibleUsersLoading(false))
  }, [])

  useEffect(() => {
    const trimmed = manualCallsign.trim()
    if (!trimmed) { setManualCheck('idle'); return }
    setManualCheck('checking')
    const t = setTimeout(() => {
      resolveCallsignToUserId(trimmed)
        .then((userId) => setManualCheck(userId ? 'found' : 'not_found'))
        .catch(() => setManualCheck('idle'))
    }, 400)
    return () => clearTimeout(t)
  }, [manualCallsign])

  const loadContacts = async () => {
    let deviceContacts: DeviceContact[]
    try {
      deviceContacts = await getDeviceContacts()
    } catch (e: any) {
      console.warn('FindFriends: getDeviceContacts failed', e)
      setDebugError(`contacts: ${e?.message ?? e}`)
      setState('error')
      return
    }
    setContacts(deviceContacts)

    // Matching is best-effort -- a real, browsable contact list is the
    // core of what RC asked for, so a match-lookup failure (network
    // blip, RPC error) shouldn't hide the list itself, just leave
    // everyone showing as "not on FlyRegs yet" for this pass.
    try {
      setMatched(await matchContactsToCallsigns(deviceContacts))
    } catch (e) {
      console.warn('FindFriends: matchContactsToCallsigns failed', e)
      setMatched(new Map())
    }
    setState('ready')
  }

  const chooseMoreContacts = async () => {
    await presentContactsAccessPicker()
    const refreshed = await requestContactsPermission()
    setLimitedAccess(refreshed.limited)
    await loadContacts()
  }

  useEffect(() => {
    if (Platform.OS === 'web') { setState('error'); return }
    setState('loading')
    ;(async () => {
      let perm: { granted: boolean; limited: boolean }
      try {
        perm = await requestContactsPermission()
      } catch (e: any) {
        console.warn('FindFriends: requestContactsPermission failed', e)
        setDebugError(`permission: ${e?.message ?? e}`)
        setState('error')
        return
      }
      if (!perm.granted) { setState('denied'); return }
      setLimitedAccess(perm.limited)
      await loadContacts()
    })().catch((e) => {
      console.warn('FindFriends: unexpected failure', e)
      setDebugError(String(e?.message ?? e))
      setState('error')
    })
  }, [])

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? contacts.filter((c) => c.name.toLowerCase().includes(q)) : contacts
    const onFlyRegs = filtered.filter((c) => matched.has(c.id))
    const notYet = filtered.filter((c) => !matched.has(c.id))
    const out: { title: string; data: DeviceContact[] }[] = []
    if (onFlyRegs.length > 0) out.push({ title: `ON FLYREGS`, data: onFlyRegs })
    if (notYet.length > 0) out.push({ title: 'NOT ON FLYREGS YET', data: notYet })
    return out
  }, [contacts, matched, query])

  const inviteToDownload = (name: string) => {
    Share.share({ message: `Join me on ${APP_NAME} — ${APP_STORE_URL}` }).catch(() => {})
  }

  return (
    <>
      <View style={styles.header}>
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={[styles.headerBtn, { color: tokens.blu, fontSize: fs(15) }]}>Close</Text>
        </Pressable>
        <Text style={[styles.title, { color: tokens.t1, fontSize: fs(16) }]}>Find Friends</Text>
        <View style={{ width: 50 }} />
      </View>

      {state !== 'loading' && (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), paddingHorizontal: 0, paddingTop: 0 }]}>
            OR SEARCH BY CALLSIGN
          </Text>
          <View style={[styles.searchWrap, { backgroundColor: tokens.bg2, borderColor: manualCheck === 'not_found' ? tokens.red : tokens.bdr, marginHorizontal: 0 }]}>
            <Icon name="magnifyingglass" size={fs(14)} color={tokens.t3} />
            <TextInput
              value={manualCallsign}
              onChangeText={setManualCallsign}
              placeholder="Their Callsign"
              placeholderTextColor={tokens.t4}
              autoCapitalize="none"
              style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(14) }]}
            />
          </View>
          {manualCheck === 'checking' && (
            <Text style={{ color: tokens.t3, fontSize: fs(12.5), marginTop: 4 }}>Checking…</Text>
          )}
          {manualCheck === 'not_found' && (
            <Text style={{ color: tokens.red, fontSize: fs(12.5), marginTop: 4 }}>No FlyRegs user with this Callsign</Text>
          )}
          {manualCheck === 'found' && (
            <Pressable
              style={{ marginTop: 6, alignSelf: 'flex-start' }}
              onPress={() => { onSelect(manualCallsign.trim()); onClose() }}
            >
              <Text style={{ color: tokens.gold, fontSize: fs(13), fontWeight: '700' }}>Add {manualCallsign.trim()}</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* RC: everyone who's opted into being findable, scrollable right
          alongside the Callsign search above -- independent of the
          contacts-permission flow below, so it works even when contacts
          are denied/empty/unavailable (the exact dead-end RC flagged
          before this existed). Hidden entirely once loaded if nobody's
          opted in yet, matching this file's existing empty-section
          convention. Capped height (not the sheet's own scroll) since the
          contacts list below still needs its own room. */}
      {!visibleUsersLoading && visibleUsers.length > 0 && (
        <>
          <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), backgroundColor: tokens.bg }]}>
            OR BROWSE PEOPLE
          </Text>
          <FlatList
            data={visibleUsers}
            keyExtractor={(u) => u.userId}
            style={{ maxHeight: 132 }}
            renderItem={({ item }) => (
              <Pressable style={styles.row} onPress={() => { onSelect(item.displayLabel); onClose() }}>
                <View style={[styles.avatar, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                  <Icon name="person.fill" size={fs(16)} color={tokens.t3} />
                </View>
                <Text style={[styles.rowName, { flex: 1, color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                  {item.displayLabel}
                </Text>
                <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
              </Pressable>
            )}
          />
        </>
      )}

      {state === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
          <Text style={[styles.emptyText, { color: tokens.t2, fontSize: fs(14) }]}>Checking your contacts…</Text>
        </View>
      )}

      {state === 'denied' && (
        <View style={styles.center}>
          <Icon name="person.crop.circle.badge.exclamationmark" size={fs(32)} color={tokens.t3} />
          <Text style={[styles.emptyText, { color: tokens.t2, fontSize: fs(14) }]}>
            FlyRegs needs contacts access to check who's already here. Enable it in Settings, then try again.
          </Text>
        </View>
      )}

      {state === 'error' && (
        <View style={styles.center}>
          <Icon name="iphone" size={fs(32)} color={tokens.t3} />
          <Text style={[styles.emptyText, { color: tokens.t2, fontSize: fs(14) }]}>
            {Platform.OS === 'web'
              ? 'Find Friends is available in the FlyRegs app.'
              : "Couldn't check your contacts right now. Try again in a moment."}
          </Text>
          {/* Dev-only diagnostic -- real error text instead of guessing at
              the cause blind, per RC's real-device crash report. Never
              shown in a production build. */}
          {__DEV__ && debugError && (
            <Text style={[styles.emptySub, { color: tokens.t4, fontSize: fs(11) }]} selectable>
              {debugError}
            </Text>
          )}
        </View>
      )}

      {state === 'ready' && contacts.length === 0 && (
        <View style={styles.center}>
          <Icon name="person.2" size={fs(32)} color={tokens.t3} />
          <Text style={[styles.emptyText, { color: tokens.t2, fontSize: fs(14) }]}>
            {limitedAccess ? "FlyRegs only has access to a limited set of your contacts." : 'No contacts found.'}
          </Text>
          {limitedAccess && (
            <Pressable onPress={chooseMoreContacts} hitSlop={10}>
              <Text style={{ color: tokens.blu, fontSize: fs(14), fontWeight: '600' }}>Choose More Contacts</Text>
            </Pressable>
          )}
        </View>
      )}

      {state === 'ready' && contacts.length > 0 && (
        <>
          <View style={[styles.searchWrap, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
            <Icon name="magnifyingglass" size={fs(14)} color={tokens.t3} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search contacts"
              placeholderTextColor={tokens.t4}
              style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(14) }]}
            />
          </View>
          {sections.length === 0 ? (
            <View style={styles.center}>
              <Text style={[styles.emptyText, { color: tokens.t2, fontSize: fs(14) }]}>No matching contacts.</Text>
            </View>
          ) : (
            <SectionList
              sections={sections}
              keyExtractor={(c) => c.id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingVertical: 6 }}
              renderSectionHeader={({ section }) => (
                <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), backgroundColor: tokens.bg }]}>
                  {section.title}
                </Text>
              )}
              renderItem={({ item }) => {
                const callsign = matched.get(item.id)
                if (callsign) {
                  return (
                    <Pressable style={styles.row} onPress={() => { onSelect(callsign); onClose() }}>
                      <View style={[styles.avatar, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                        <Icon name="person.fill" size={fs(16)} color={tokens.t3} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.rowName, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.name}</Text>
                        <Text style={[styles.rowSub, { color: tokens.blu, fontSize: fs(12.5) }]}>{callsign}</Text>
                      </View>
                      <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
                    </Pressable>
                  )
                }
                return (
                  <View style={styles.row}>
                    <View style={[styles.avatar, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                      <Icon name="person.fill" size={fs(16)} color={tokens.t4} />
                    </View>
                    <Text style={[styles.rowName, { flex: 1, color: tokens.t2, fontSize: fs(14.5) }]}>{item.name}</Text>
                    <Pressable hitSlop={8} onPress={() => inviteToDownload(item.name)}>
                      <Text style={{ color: tokens.blu, fontSize: fs(12.5), fontWeight: '600' }}>Invite</Text>
                    </Pressable>
                  </View>
                )
              }}
            />
          )}
        </>
      )}
    </>
  )
}

// Standalone modal wrapper -- only safe to use where nothing else is
// already presenting a <Modal> (Ready Room, its one and only caller today).
// Aircraft/folder invite flows use FindFriendsPickerBody directly, as a
// step inside their OWN already-open modal instead.
export function FindFriendsSheet({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean
  onClose: () => void
  onSelect: (callsign: string) => void
}) {
  const { tokens } = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={[styles.card, { backgroundColor: tokens.bg, borderColor: tokens.bdr, paddingBottom: Math.max(0, insets.bottom + 8) }]}>
          {visible && <FindFriendsPickerBody onClose={onClose} onSelect={onSelect} />}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  card: { maxHeight: '75%', minHeight: 220, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: 1, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(128,128,128,0.25)' },
  headerBtn: { fontWeight: '500' },
  title: { fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  emptyText: { textAlign: 'center' },
  emptySub: { textAlign: 'center' },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginTop: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  searchInput: { flex: 1, padding: 0 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 11 },
  avatar: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  rowName: { fontWeight: '600' },
  rowSub: { marginTop: 1, fontWeight: '600' },
})
