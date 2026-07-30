import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, ActivityIndicator, Alert, Modal } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { supabase } from '@/lib/supabase'
import {
  searchParts, getAircraftEquipment, addAircraftEquipment, removeAircraftEquipment,
  getAircraftReminders, addAircraftReminder, removeAircraftReminder,
  type AdPart, type AircraftEquipment, type AircraftReminder,
} from '@/lib/adParts'

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
}

function daysUntil(dateStr: string): number {
  const due = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - now.getTime()) / 86400000)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default function AircraftDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPremium } = useAuth()
  const [aircraft, setAircraft] = useState<UserAircraft | null>(null)
  const [equipment, setEquipment] = useState<AircraftEquipment[]>([])
  const [reminders, setReminders] = useState<AircraftReminder[]>([])
  const [loading, setLoading] = useState(true)
  const [partPickerVisible, setPartPickerVisible] = useState(false)
  const [reminderFormVisible, setReminderFormVisible] = useState(false)

  const load = useCallback(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      supabase.from('user_aircraft').select('id, make, model, nickname').eq('id', id).single(),
      getAircraftEquipment(id),
      getAircraftReminders(id),
    ]).then(([acRes, equip, rem]) => {
      if (acRes.data) setAircraft(acRes.data as UserAircraft)
      setEquipment(equip)
      setReminders(rem)
      setLoading(false)
    })
  }, [id])

  useEffect(() => { load() }, [load])

  const handleRemoveEquipment = async (equipId: string) => {
    await removeAircraftEquipment(equipId)
    setEquipment((prev) => prev.filter((e) => e.id !== equipId))
  }

  const handleRemoveReminder = async (remId: string) => {
    await removeAircraftReminder(remId)
    setReminders((prev) => prev.filter((r) => r.id !== remId))
  }

  const openAddEquipment = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    setPartPickerVisible(true)
  }

  const openAddReminder = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
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

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={aircraft.nickname || `${aircraft.make} ${aircraft.model}`} onBack={() => router.back()} />
      <TabletContainer>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.acLine, { color: tokens.t1, fontSize: fs(17) }]}>{aircraft.make} {aircraft.model}</Text>
          {aircraft.nickname && <Text style={[styles.acSub, { color: tokens.t3, fontSize: fs(13) }]}>{aircraft.nickname}</Text>}

          <View style={styles.disclaimerCard}>
            <Icon name="info.circle" size={14} color={tokens.t3} />
            <Text style={[styles.disclaimerText, { color: tokens.t3, fontSize: fs(11.5) }]}>
              Equipment tags and reminders are based only on what you enter here — FlyRegs doesn't verify serial
              numbers or maintenance records. ADs shown may apply; always confirm against your aircraft's official
              records.
            </Text>
          </View>

          <View style={styles.sectionHeader}>
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>EQUIPMENT</Text>
            <Pressable onPress={openAddEquipment} hitSlop={10}>
              <Icon name="plus.circle.fill" size={20} color={tokens.blu} />
            </Pressable>
          </View>
          {equipment.length === 0 ? (
            <Text style={[styles.emptyHint, { color: tokens.t3, fontSize: fs(13) }]}>
              Tag a specific engine, prop, or avionics box so AD alerts also catch part-keyed ADs, not just ones for
              your airframe model.
            </Text>
          ) : (
            <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              {equipment.map((e, i) => (
                <View key={e.id} style={[styles.row, i < equipment.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}>
                  <Icon name="wrench" size={15} color={tokens.blu} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]}>{e.part.name}</Text>
                    {e.part.manufacturer && <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12) }]}>{e.part.manufacturer}</Text>}
                  </View>
                  <Pressable onPress={() => handleRemoveEquipment(e.id)} hitSlop={10}>
                    <Icon name="trash" size={16} color={tokens.t3} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <View style={[styles.sectionHeader, { marginTop: 20 }]}>
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>REMINDERS</Text>
            <Pressable onPress={openAddReminder} hitSlop={10}>
              <Icon name="plus.circle.fill" size={20} color={tokens.blu} />
            </Pressable>
          </View>
          {reminders.length === 0 ? (
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
                  <View key={r.id} style={[styles.row, i < reminders.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}>
                    <Icon name="hourglass" size={15} color={overdue ? tokens.amb : soon ? tokens.gold : tokens.t3} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]}>{r.title}</Text>
                      <Text style={[styles.rowSub, { color: overdue ? tokens.amb : tokens.t3, fontSize: fs(12) }]}>
                        {overdue ? `${Math.abs(days)}d overdue` : days === 0 ? 'Due today' : `Due in ${days}d`} · {r.dueDate}
                        {r.linkedAdNumber ? ` · AD ${r.linkedAdNumber}` : ''}
                      </Text>
                    </View>
                    <Pressable onPress={() => handleRemoveReminder(r.id)} hitSlop={10}>
                      <Icon name="trash" size={16} color={tokens.t3} />
                    </Pressable>
                  </View>
                )
              })}
            </View>
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
        }}
      />
      <ReminderFormModal
        visible={reminderFormVisible}
        onClose={() => setReminderFormVisible(false)}
        onSaved={async (title, dueDate, notes) => {
          if (!aircraft || !session) return
          try {
            await addAircraftReminder(session.user.id, aircraft.id, title, dueDate, null, notes)
            setReminderFormVisible(false)
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
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleChange = (text: string) => {
    setQuery(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (text.trim().length < 2) { setResults([]); return }
    setSearching(true)
    debounceRef.current = setTimeout(() => {
      searchParts(text).then((hits) => { setResults(hits); setSearching(false) }).catch(() => setSearching(false))
    }, 250)
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.modalRoot, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Add Equipment" onBack={onClose} />
        <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="magnifyingglass" size={16} color={tokens.t3} />
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
          <ScrollView contentContainerStyle={{ padding: 12 }}>
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
                <Icon name="plus.circle.fill" size={20} color={tokens.blu} />
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

function ReminderFormModal({ visible, onClose, onSaved }: { visible: boolean; onClose: () => void; onSaved: (title: string, dueDate: string, notes: string) => void }) {
  const { tokens } = useTheme()
  const fs = useFS()
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')

  const handleSave = () => {
    if (!title.trim()) { Alert.alert('Title required', 'Enter what this reminder is for.'); return }
    if (!DATE_RE.test(dueDate.trim())) { Alert.alert('Invalid date', 'Enter the due date as YYYY-MM-DD.'); return }
    onSaved(title, dueDate.trim(), notes)
    setTitle(''); setDueDate(''); setNotes('')
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>New Reminder</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Icon name="xmark" size={18} color={tokens.t3} />
            </Pressable>
          </View>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="What (e.g. ELT battery, Annual)"
            placeholderTextColor={tokens.t3}
            style={[styles.formInput, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }]}
          />
          <TextInput
            value={dueDate}
            onChangeText={setDueDate}
            placeholder="Due date (YYYY-MM-DD)"
            placeholderTextColor={tokens.t3}
            style={[styles.formInput, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }]}
            keyboardType="numbers-and-punctuation"
          />
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Notes (optional)"
            placeholderTextColor={tokens.t3}
            style={[styles.formInput, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }]}
          />
          <Pressable style={[styles.addButton, { backgroundColor: tokens.blu }]} onPress={handleSave}>
            <Text style={styles.addButtonText}>Save Reminder</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  acLine: { fontWeight: '700' },
  acSub: { marginTop: 2, marginBottom: 4 },

  disclaimerCard: {
    flexDirection: 'row', gap: 8, marginTop: 14, marginBottom: 4,
    padding: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.03)',
  },
  disclaimerText: { flex: 1, lineHeight: 16 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, marginBottom: 8 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5 },
  emptyHint: { lineHeight: 18, marginBottom: 4 },

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
  formInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  addButton: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  addButtonText: { color: '#fff', fontWeight: '600', fontSize: 14.5 },
})
