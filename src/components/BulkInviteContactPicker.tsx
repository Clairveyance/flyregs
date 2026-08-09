import { useEffect, useMemo, useState } from 'react'
import { View, Text, Modal, Pressable, TextInput, FlatList, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native'
import * as Contacts from 'expo-contacts'
import * as SMS from 'expo-sms'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { useConfirm } from '@/components/ConfirmDialog'

interface PickableContact {
  id: string
  name: string
  phone: string
}

// BB-078, RC real-device beta report: the Group icon just opened the plain
// OS share sheet one contact at a time -- no real bulk-add. Deliberately
// does NOT send one message to a multi-recipient thread (that would expose
// every invitee's number to every other invitee) -- loops the native SMS
// composer once per selected contact instead, same invite text each time.
// Each send still needs the user's own tap in that native compose sheet
// (no OS lets an app silently fire off texts), so this is "queue up N sends
// quickly" rather than "one tap, N messages gone" -- an honest description
// of what's actually possible, not a promise the platform can't keep.
export function BulkInviteContactPicker({
  visible,
  onClose,
  message,
  onSent,
}: {
  visible: boolean
  onClose: () => void
  /** The exact text sent to every selected contact -- same invite link each time. */
  message: string
  /** Called once after the send loop finishes, with how many actually went through. */
  onSent: (sentCount: number) => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const confirm = useConfirm()
  const [permissionState, setPermissionState] = useState<'checking' | 'denied' | 'granted'>('checking')
  const [contacts, setContacts] = useState<PickableContact[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    if (!visible) return
    setQuery('')
    setSelected(new Set())
    setSending(null)
    setPermissionState('checking')
    ;(async () => {
      const existing = await Contacts.getPermissionsAsync()
      const perm = existing.granted ? existing : await Contacts.requestPermissionsAsync()
      if (!perm.granted) { setPermissionState('denied'); return }
      setPermissionState('granted')
      const details = await Contacts.Contact.getAllDetails(
        [Contacts.ContactField.FULL_NAME, Contacts.ContactField.PHONES],
        { sortOrder: Contacts.ContactsSortOrder.GivenName },
      )
      const withPhones = details
        .filter((c) => c.fullName && c.phones && c.phones.length > 0)
        .map((c) => ({ id: (c as any).id ?? c.fullName!, name: c.fullName!, phone: c.phones![0].number ?? '' }))
        .filter((c) => c.phone)
      setContacts(withPhones)
    })()
  }, [visible])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts
    return contacts.filter((c) => c.name.toLowerCase().includes(q))
  }, [contacts, query])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSend = async () => {
    const targets = contacts.filter((c) => selected.has(c.id))
    if (targets.length === 0) return
    const available = await SMS.isAvailableAsync()
    if (!available) {
      confirm({ title: 'No Messaging Available', message: "This device can't send text messages, so a bulk invite can't go out this way. Use \"Invite by Link\" instead and share it however works.", cancelLabel: null })
      return
    }
    setSending({ done: 0, total: targets.length })
    let sentCount = 0
    // Sequential, not parallel -- each sendSMSAsync opens ITS OWN native
    // compose sheet and its promise only resolves once the user dismisses
    // it (sent or cancelled), so awaiting one at a time is what actually
    // presents them one after another instead of racing several sheets.
    for (let i = 0; i < targets.length; i++) {
      try {
        const { result } = await SMS.sendSMSAsync([targets[i].phone], message)
        if (result === 'sent' || result === 'unknown') sentCount++
      } catch {
        // One recipient's send failing (bad number, etc.) shouldn't abort
        // the rest of the queue.
      }
      setSending({ done: i + 1, total: targets.length })
    }
    setSending(null)
    onSent(sentCount)
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.scrim} onPress={sending ? undefined : onClose} />
        <View style={[styles.card, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          <View style={styles.header}>
            <Pressable onPress={onClose} disabled={!!sending} hitSlop={10}>
              <Text style={[styles.headerBtn, { color: tokens.blu, fontSize: fs(15) }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(16) }]}>Invite Multiple</Text>
            <Pressable onPress={handleSend} disabled={selected.size === 0 || !!sending} hitSlop={10}>
              <Text style={[styles.headerBtn, { color: selected.size === 0 || sending ? tokens.t4 : tokens.blu, fontSize: fs(15), fontWeight: '700' }]}>
                Invite{selected.size > 0 ? ` (${selected.size})` : ''}
              </Text>
            </Pressable>
          </View>

          {permissionState === 'checking' && (
            <View style={styles.center}><ActivityIndicator color={tokens.blu} /></View>
          )}

          {permissionState === 'denied' && (
            <View style={styles.center}>
              <Icon name="person.crop.circle.badge.exclamationmark" size={fs(32)} color={tokens.t3} />
              <Text style={[styles.emptyText, { color: tokens.t2, fontSize: fs(14) }]}>
                FlyRegs needs contacts access to pick who to invite. Enable it in Settings, then try again.
              </Text>
            </View>
          )}

          {permissionState === 'granted' && sending && (
            <View style={styles.center}>
              <ActivityIndicator color={tokens.blu} />
              <Text style={[styles.emptyText, { color: tokens.t2, fontSize: fs(14) }]}>
                Sending {sending.done + 1 <= sending.total ? sending.done + 1 : sending.total} of {sending.total}…
              </Text>
              <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                Tap Send in each message that opens to continue.
              </Text>
            </View>
          )}

          {permissionState === 'granted' && !sending && (
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
              {contacts.length === 0 ? (
                <View style={styles.center}>
                  <Text style={[styles.emptyText, { color: tokens.t2, fontSize: fs(14) }]}>
                    No contacts with a phone number found.
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={filtered}
                  keyExtractor={(c) => c.id}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item }) => {
                    const isSel = selected.has(item.id)
                    return (
                      <Pressable style={styles.row} onPress={() => toggle(item.id)}>
                        <View style={[
                          styles.checkbox,
                          isSel ? { backgroundColor: tokens.blu, borderColor: tokens.blu } : { borderColor: tokens.t3 },
                        ]}>
                          {isSel && <Icon name="checkmark" size={fs(11)} color="#fff" />}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.rowName, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.name}</Text>
                          <Text style={[styles.rowPhone, { color: tokens.t3, fontSize: fs(12.5) }]}>{item.phone}</Text>
                        </View>
                      </Pressable>
                    )
                  }}
                />
              )}
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  card: { height: '75%', borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: 1, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(128,128,128,0.25)' },
  headerBtn: { fontWeight: '500' },
  title: { fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  emptyText: { textAlign: 'center' },
  emptySub: { textAlign: 'center' },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginTop: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  searchInput: { flex: 1, padding: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 11 },
  checkbox: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  rowName: { fontWeight: '600' },
  rowPhone: { marginTop: 1 },
})
