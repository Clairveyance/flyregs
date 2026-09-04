import { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, ActivityIndicator, Modal } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { useConfirm } from '@/components/ConfirmDialog'
import { Icon } from '@/components/Icon'
import { type AircraftAdNotification, type ComplianceKind } from '@/lib/adNotifications'
import { type AircraftReminder } from '@/lib/adParts'

// Extracted from my-aircraft/[id].tsx (2026-09-03) -- RC reported B39's AD
// compliance feature "doesn't show up at all" on his real account. Root
// cause: it was only ever wired into ONE of three places that let a user
// mark an AD complied. The aircraft-detail screen's small per-row icon got
// the new modal; My Fleet's ring, its collapsed row badge, and its expanded
// AD chip (my-aircraft/index.tsx) all still called the OLD one-shot
// confirm-only flow (no recurring option, no note, no next-due tracking).
// RC almost certainly enters through the ring or the row -- the most
// prominent, most-used surface -- which is exactly why he never saw any of
// what Preview showed. Sharing this component is what lets BOTH screens
// open the identical modal, on both existing and future ADs, instead of
// drifting into two competing implementations of the same feature.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
export function DatePickerModal({
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

export function AdComplianceModal({
  visible, ad, currentHobbs, existingReminder, onClose, onSaved,
}: {
  visible: boolean
  ad: AircraftAdNotification | null
  currentHobbs: number | null
  existingReminder: AircraftReminder | null
  onClose: () => void
  onSaved: (input: {
    kind: ComplianceKind
    compliedDate: string
    note: string
    nextDueDate: string | null
    nextDueHobbs: number | null
    compliedHobbs: number | null
  }) => Promise<void>
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const confirm = useConfirm()
  const insets = useSafeAreaInsets()

  const [kind, setKind] = useState<ComplianceKind>('one_time')
  const [compliedDate, setCompliedDate] = useState('')
  const [note, setNote] = useState('')
  const [nextDueDate, setNextDueDate] = useState('')
  const [nextDueHobbsText, setNextDueHobbsText] = useState('')
  const [compliedHobbsText, setCompliedHobbsText] = useState('')
  const [picking, setPicking] = useState<null | 'complied' | 'next'>(null)
  const [saving, setSaving] = useState(false)

  // Reset every time the sheet opens, not on mount -- same discipline as
  // ReminderFormModal and DatePickerModal, which both had real bugs from
  // carrying stale state across openings.
  useEffect(() => {
    if (!visible) return
    // toISODate (local), NOT toISOString (UTC). toISOString().slice(0,10)
    // yields the UTC calendar day, so for anyone west of Greenwich after
    // ~17:00 local this pre-filled TOMORROW: a mechanic in Los Angeles
    // finishing an AD at 6pm on 3 Sep got a form defaulted to 2026-09-04.
    // If they don't notice, the maintenance record is dated in the future and
    // -- for a recurring AD -- every subsequent next-due date is anchored a
    // day late. Every other date path in this feature already handles this
    // (my-aircraft/[id].tsx writes `compliedDate + 'T12:00:00'` precisely so a
    // bare date can't read back as the previous day, and toISODate above
    // exists to format in local time); this one line skipped it.
    const today = toISODate(new Date())
    setKind(ad?.complianceKind ?? 'one_time')
    setCompliedDate(ad?.compliedAt ? ad.compliedAt.slice(0, 10) : today)
    setNote(ad?.compliedNote ?? '')
    setNextDueDate(existingReminder?.dueDate ?? '')
    setNextDueHobbsText(existingReminder?.dueHobbsHours != null ? String(existingReminder.dueHobbsHours) : '')
    setCompliedHobbsText(currentHobbs != null ? String(currentHobbs) : '')
    setPicking(null)
    setSaving(false)
  }, [visible, ad?.id])

  const dateValid = DATE_RE.test(compliedDate)
  const nextHobbs = nextDueHobbsText.trim() ? Number(nextDueHobbsText) : null
  const nextHobbsValid = nextDueHobbsText.trim() === '' || (Number.isFinite(nextHobbs) && (nextHobbs as number) > 0)
  // A recurring AD has to be due again at SOME point, or it is just a
  // one-time entry wearing the wrong label -- and it would sit in the
  // recurring section forever with nothing to count down to.
  const recurringHasTarget = kind === 'one_time' || DATE_RE.test(nextDueDate) || (nextHobbs != null && nextHobbs > 0)
  const canSave = dateValid && nextHobbsValid && recurringHasTarget && !saving

  const save = async () => {
    if (!canSave || !ad) return
    setSaving(true)
    try {
      const compliedHobbs = compliedHobbsText.trim() ? Number(compliedHobbsText) : null
      await onSaved({
        kind,
        compliedDate,
        note,
        nextDueDate: kind === 'recurring' && DATE_RE.test(nextDueDate) ? nextDueDate : null,
        nextDueHobbs: kind === 'recurring' ? nextHobbs : null,
        compliedHobbs: kind === 'recurring' && Number.isFinite(compliedHobbs) ? compliedHobbs : null,
      })
      onClose()
    } catch (e: any) {
      confirm({ title: 'Could not save', message: e?.message ?? 'Unknown error', cancelLabel: null })
    }
    setSaving(false)
  }

  if (!ad) return null

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr, maxHeight: '88%', paddingBottom: Math.max(18, insets.bottom + 8) }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(17) }]}>AD {ad.adNumber}</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Icon name="xmark" size={fs(18)} color={tokens.t3} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
            <Text style={{ color: tokens.t3, fontSize: fs(11), fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 }}>COMPLIANCE TYPE</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 18 }}>
              {([['one_time', 'One-time'], ['recurring', 'Recurring']] as [ComplianceKind, string][]).map(([k, label]) => (
                <Pressable
                  key={k}
                  onPress={() => setKind(k)}
                  style={{
                    flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, alignItems: 'center',
                    borderColor: kind === k ? tokens.blu : tokens.bdr,
                    backgroundColor: kind === k ? tokens.bdim : 'transparent',
                  }}
                >
                  <Text style={{ color: kind === k ? tokens.blu : tokens.t2, fontSize: fs(14.5), fontWeight: '600' }}>{label}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={{ color: tokens.t3, fontSize: fs(11), fontWeight: '600', letterSpacing: 0.5 }}>DATE COMPLIED</Text>
            <Pressable
              onPress={() => setPicking('complied')}
              style={{ borderWidth: 1, borderColor: tokens.bdr, borderRadius: 10, padding: 13, marginTop: 6, marginBottom: 16 }}
            >
              <Text style={{ color: dateValid ? tokens.t1 : tokens.t4, fontSize: ifs(15) }}>
                {dateValid ? compliedDate : 'Tap to choose a date'}
              </Text>
            </Pressable>

            <Text style={{ color: tokens.t3, fontSize: fs(11), fontWeight: '600', letterSpacing: 0.5 }}>HOW IT WAS COMPLIED</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              multiline
              placeholder="e.g. Installed STC SA01234NY; replaced fuel hose assembly per Goodrich SB 7A1508"
              placeholderTextColor={tokens.t4}
              style={{
                borderWidth: 1, borderColor: tokens.bdr, borderRadius: 10, padding: 13, marginTop: 6,
                color: tokens.t1, fontSize: ifs(15), minHeight: 92, textAlignVertical: 'top', marginBottom: 16,
              }}
            />

            {kind === 'recurring' && (
              <>
                <Text style={{ color: tokens.t3, fontSize: fs(11), fontWeight: '600', letterSpacing: 0.5 }}>NEXT DUE — DATE</Text>
                <Pressable
                  onPress={() => setPicking('next')}
                  style={{ borderWidth: 1, borderColor: tokens.bdr, borderRadius: 10, padding: 13, marginTop: 6, marginBottom: 14 }}
                >
                  <Text style={{ color: DATE_RE.test(nextDueDate) ? tokens.t1 : tokens.t4, fontSize: ifs(15) }}>
                    {DATE_RE.test(nextDueDate) ? nextDueDate : 'Tap to choose a date'}
                  </Text>
                </Pressable>

                <Text style={{ color: tokens.t3, fontSize: fs(11), fontWeight: '600', letterSpacing: 0.5 }}>NEXT DUE — AIRFRAME HOURS</Text>
                <TextInput
                  value={nextDueHobbsText}
                  onChangeText={setNextDueHobbsText}
                  keyboardType="decimal-pad"
                  placeholder="e.g. 2150"
                  placeholderTextColor={tokens.t4}
                  style={{ borderWidth: 1, borderColor: tokens.bdr, borderRadius: 10, padding: 13, marginTop: 6, marginBottom: 14, color: tokens.t1, fontSize: ifs(15) }}
                />

                <Text style={{ color: tokens.t3, fontSize: fs(11), fontWeight: '600', letterSpacing: 0.5 }}>HOURS AT COMPLIANCE</Text>
                <TextInput
                  value={compliedHobbsText}
                  onChangeText={setCompliedHobbsText}
                  keyboardType="decimal-pad"
                  placeholder="e.g. 2050"
                  placeholderTextColor={tokens.t4}
                  style={{ borderWidth: 1, borderColor: tokens.bdr, borderRadius: 10, padding: 13, marginTop: 6, marginBottom: 6, color: tokens.t1, fontSize: ifs(15) }}
                />
                <Text style={{ color: tokens.t4, fontSize: fs(12), marginBottom: 16, lineHeight: fs(12) * 1.4 }}>
                  Give a date, hours, or both. Recurring ADs move out of the open list and into Recurring ADs, where they turn amber inside 30 days or 30 hours and red once past due.
                </Text>
              </>
            )}

            {!recurringHasTarget && (
              <Text style={{ color: tokens.amb, fontSize: fs(13), marginBottom: 12 }}>
                A recurring AD needs a next-due date or hours.
              </Text>
            )}

            <Pressable
              onPress={save}
              disabled={!canSave}
              style={{
                backgroundColor: canSave ? tokens.blu : tokens.bdim,
                borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 4,
              }}
            >
              {saving
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={{ color: canSave ? '#fff' : tokens.t4, fontSize: fs(15.5), fontWeight: '700' }}>Save compliance record</Text>}
            </Pressable>

            <Text style={{ color: tokens.t4, fontSize: fs(11.5), marginTop: 12, lineHeight: fs(11.5) * 1.45 }}>
              FlyRegs records what you enter here. It does not independently verify compliance — your own maintenance records remain the official source.
            </Text>
          </ScrollView>

          <DatePickerModal
            visible={picking !== null}
            initialDate={picking === 'next' ? nextDueDate : compliedDate}
            onClose={() => setPicking(null)}
            onSelect={(iso) => (picking === 'next' ? setNextDueDate(iso) : setCompliedDate(iso))}
            tokens={tokens}
            fs={fs}
          />
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  datePickerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, elevation: 1000 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, gap: 10 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  modalTitle: { fontWeight: '700' },
})
