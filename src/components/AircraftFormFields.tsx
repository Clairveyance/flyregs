import { useState, useEffect, useRef } from 'react'
import { View, Text, Pressable, ScrollView, TextInput, StyleSheet, ActivityIndicator, Modal } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { supabase } from '@/lib/supabase'
import { useConfirm } from '@/components/ConfirmDialog'
import {
  suggestTypeDesignator, searchTypeDesignators, searchManufacturers, searchMarketingNames,
  type TypeDesignatorSuggestion,
} from '@/lib/aircraftModels'

// Shared between the Add Aircraft form (my-aircraft/index.tsx) and
// EditAircraftModal below (my-aircraft/[id].tsx) -- extracted so editing
// only lives in one place. RC: "we don't need this edit button here. the
// editing takes place once inside the a/c page." The list screen used to
// have its own copy of EditAircraftModal; now only the detail screen
// triggers it.

export interface UserAircraft {
  id: string
  make: string
  model: string
  nickname: string | null
  type_designator: string | null
  year: number | null
  // Self-reported usage tracking (RC-approved design, 2026-08-07) -- see
  // sync/migrations_hobbs_tracking.sql. Not present on every screen's
  // select() (e.g. the Fleet list doesn't need it), so both are optional.
  current_hobbs_hours?: number | null
  hobbs_updated_at?: string | null
}

// Typeahead against the real FAA registry catalog (task #12, backed by
// #11's aircraft_type_designators table -- 9,229 real Type-Certificated
// designators, not a guess). Debounced so every keystroke doesn't fire a
// query; shows up to 8 "MANUFACTURER — DESIGNATOR" matches, tapping one
// fills the designator field and, if make is still blank, the manufacturer
// too.
export function TypeDesignatorField({
  label, value, onChangeText, onSelectManufacturer, tokens, fs, style,
}: {
  label?: string
  value: string
  onChangeText: (text: string) => void
  onSelectManufacturer?: (mfr: string) => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  style?: object
}) {
  const ifs = useInputFS()
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
    <View style={label ? style : undefined}>
      {label ? <Text style={[styles.fieldLabel, { color: tokens.t3, fontSize: fs(11.5) }]}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        // Deferred so a suggestion tap's own touch event lands before the
        // list unmounts -- an immediate onBlur hide would swallow the tap.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="Type designator (required, e.g. PA-28-181)"
        placeholderTextColor={tokens.t3}
        // NOT autoCapitalize="characters" -- that forced every keystroke to
        // appear as a shouted capital while typing (BB-074, real device
        // beta report: "typing area input is defaulted to all CAPS").
        // Storage still normalizes to uppercase at save time below, so AD
        // matching (which expects FAA-style "PA-28-181") is unaffected --
        // this only changes what the user sees while typing.
        autoCapitalize="none"
        style={[styles.input, { color: tokens.t1, fontSize: ifs(14.5), borderColor: tokens.bdr }, label ? undefined : style]}
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
export function MakeField({
  label, value, onChangeText, tokens, fs, style,
}: {
  label?: string
  value: string
  onChangeText: (text: string) => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  style?: object
}) {
  const ifs = useInputFS()
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
    <View style={label ? style : undefined}>
      {label ? <Text style={[styles.fieldLabel, { color: tokens.t3, fontSize: fs(11.5) }]}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="Make (e.g. Cessna)"
        placeholderTextColor={tokens.t3}
        style={[styles.input, { color: tokens.t1, fontSize: ifs(14.5), borderColor: tokens.bdr }, label ? undefined : style]}
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
// names). Selecting a suggestion also offers its known type designator via
// onSelectDesignator, same auto-suggest behavior typing the full name out
// would have triggered.
export function ModelField({
  label, value, onChangeText, onSelectDesignator, tokens, fs, style,
}: {
  label?: string
  value: string
  onChangeText: (text: string) => void
  onSelectDesignator?: (designator: string) => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  style?: object
}) {
  const ifs = useInputFS()
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
    <View style={label ? style : undefined}>
      {label ? <Text style={[styles.fieldLabel, { color: tokens.t3, fontSize: fs(11.5) }]}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="Model name (e.g. Skyhawk) — leave blank if none"
        placeholderTextColor={tokens.t3}
        style={[styles.input, { color: tokens.t1, fontSize: ifs(14.5), borderColor: tokens.bdr }, label ? undefined : style]}
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
export function YearField({
  label, value, onPress, tokens, fs, style,
}: {
  label?: string
  value: number | null
  onPress: () => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  style?: object
}) {
  return (
    <View style={label ? style : undefined}>
      {label ? <Text style={[styles.fieldLabel, { color: tokens.t3, fontSize: fs(11.5) }]}>{label}</Text> : null}
      <Pressable
        onPress={onPress}
        style={[styles.input, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderColor: tokens.bdr }, label ? undefined : style]}
      >
        <Text style={{ color: value ? tokens.t1 : tokens.t3, fontSize: fs(14.5) }}>
          {value ?? 'Year (optional)'}
        </Text>
        <Icon name="chevron.down" size={fs(14)} color={tokens.t4} />
      </Pressable>
    </View>
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

// A real scroll-wheel picker built from plain ScrollView snap-scrolling --
// no native picker dependency -- `snapToInterval` + `decelerationRate="fast"`
// + `onMomentumScrollEnd` is the standard RN pattern for this, and all
// three work on RN Web too.
export function YearPickerModal({
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

// The one place aircraft make/model/nickname/year/type get edited -- RC:
// "the editing takes place once inside the a/c page. Make sure editing IS
// available inside for all things."
export function EditAircraftModal({ aircraft, onClose, onSaved }: { aircraft: UserAircraft | null; onClose: () => void; onSaved: () => void }) {
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const ifs = useInputFS()
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
    // Uppercased here, once, at save -- not while typing (see
    // TypeDesignatorField's autoCapitalize note above) -- so AD matching
    // still gets the FAA-style "PA-28-181" it expects regardless of case.
    const trimmedType = typeDesignator.trim().toUpperCase()
    const trimmedModel = model.trim() || trimmedType
    if (!trimmedMake || !trimmedModel) {
      confirm({ title: 'Make and model required', message: 'Enter both the aircraft make and model.', cancelLabel: null })
      return
    }
    if (!trimmedType) {
      confirm({ title: 'Type designator required', message: 'Enter the FAA type designator (e.g. PA-28-181, 172S) so we can match Airworthiness Directives correctly.', cancelLabel: null })
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
      confirm({ title: 'Could not save changes', message: error.message, cancelLabel: null })
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
          <MakeField label="MAKE" value={make} onChangeText={setMake} tokens={tokens} fs={fs} style={{ marginTop: 14 }} />
          <ModelField
            label="MODEL NAME"
            value={model}
            onChangeText={handleModelChange}
            onSelectDesignator={(d) => { if (!typeDesignatorEdited.current) setTypeDesignator(d) }}
            tokens={tokens}
            fs={fs}
            style={{ marginTop: 12 }}
          />
          <View style={{ marginTop: 12 }}>
            {/* RC: "the explan. para should come up as CTA once, then reduce
                to an info icon" -- same tap-to-reveal pattern used elsewhere
                in the app. forceOnce shows the full explanation the first
                time someone edits an aircraft, then it collapses to the
                icon beside the label it actually explains. */}
            <View style={styles.labelRow}>
              <Text style={[styles.fieldLabel, { color: tokens.t3, fontSize: fs(11.5), marginBottom: 0 }]}>
                TYPE DESIGNATOR
              </Text>
              <InfoPopup
                id="aircraft-model-vs-type"
                title="Model vs. Type Designator"
                body="Model is the marketing name (Skyhawk, Warrior). Type designator is the FAA code (172S, PA-28-181) that Airworthiness Directives are actually filed under — it's what AD matching uses. No marketing name? Enter the type in both fields."
                forceOnce
                iconSize={fs(14)}
              />
            </View>
            <TypeDesignatorField
              value={typeDesignator}
              onChangeText={handleTypeDesignatorChange}
              onSelectManufacturer={(mfr) => { if (!make.trim()) setMake(mfr) }}
              tokens={tokens}
              fs={fs}
              style={{ marginTop: 5 }}
            />
          </View>
          <YearField label="YEAR" value={year} onPress={() => setYearPickerOpen(true)} tokens={tokens} fs={fs} style={{ marginTop: 12 }} />
          <View style={{ marginTop: 12 }}>
            <Text style={[styles.fieldLabel, { color: tokens.t3, fontSize: fs(11.5) }]}>NICKNAME</Text>
            <TextInput
              value={nickname}
              onChangeText={setNickname}
              placeholder="Optional, e.g. N12345"
              placeholderTextColor={tokens.t3}
              style={[styles.input, { color: tokens.t1, fontSize: ifs(14.5), borderColor: tokens.bdr }]}
            />
          </View>
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

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  // RC, on the edit sheet: "this a/c edit screen lost the Make Model Type
  // designations for the bars." These fields only ever carried their name in
  // the PLACEHOLDER, which is exactly the text that disappears the moment a
  // value exists -- so editing a saved aircraft showed three unlabeled boxes
  // reading "Cessna / 172 / 172S" with no way to tell which was which.
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 2 },
  fieldLabel: { fontWeight: '600', letterSpacing: 0.3, marginBottom: 5, marginLeft: 2 },
  suggestBox: { borderWidth: 1, borderRadius: 8, marginTop: 4, overflow: 'hidden' },
  // Widened from paddingVertical: 9 -- BB-092, real device beta report:
  // rows were "really tight and cramped, hard to select an option without
  // hitting another one."
  suggestRow: { paddingHorizontal: 14, paddingVertical: 13, minHeight: 44 },
  typeHint: { marginTop: 8, marginBottom: 2 },
  addButton: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  addButtonText: { color: '#fff', fontWeight: '600', fontSize: 14.5 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, gap: 4 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { fontWeight: '700' },
})
