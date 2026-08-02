import { useEffect, useState, useRef } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert, Modal } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { supabase } from '@/lib/supabase'
import {
  suggestTypeDesignator, searchTypeDesignators, searchManufacturers, searchMarketingNames,
  type TypeDesignatorSuggestion,
} from '@/lib/aircraftModels'
import { backfillAircraftAds } from '@/lib/adNotifications'

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

// Pro: 1 saved aircraft (most owners have exactly one). Premium: unlimited --
// a natural upsell for shops/mechanics tracking a fleet. See the pricing
// pivot's aircraft-cap decision in flyregs_decisions.md.
const PRO_AIRCRAFT_CAP = 1

export default function MyAircraftScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro, isPremium } = useAuth()
  const [aircraft, setAircraft] = useState<UserAircraft[]>([])
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
    supabase
      .from('user_aircraft')
      .select('id, make, model, nickname, type_designator, year')
      .order('make')
      .then(({ data, error }) => {
        if (!error && data) setAircraft(data as UserAircraft[])
        setLoading(false)
      })
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

  const handleRemove = async (id: string) => {
    await supabase.from('user_aircraft').delete().eq('id', id)
    setAircraft((prev) => prev.filter((a) => a.id !== id))
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="My Aircraft" onBack={() => router.back()} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.intro, { color: tokens.t3, fontSize: fs(13) }]}>
            Save the aircraft you fly or maintain to get alerted when a new or updated Airworthiness Directive
            applies to them, instead of scanning the full AD list yourself.
          </Text>

          {aircraft.length === 0 ? (
            <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(14) }]}>No aircraft saved yet.</Text>
          ) : (
            <View style={[styles.list, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              {aircraft.map((a, i) => (
                <Pressable
                  key={a.id}
                  style={[styles.row, i < aircraft.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}
                  onPress={() => router.push(`/my-aircraft/${a.id}` as any)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowMake, { color: tokens.t1, fontSize: fs(14.5) }]}>
                      {a.year ? `${a.year} ` : ''}{a.make} {a.model}
                    </Text>
                    {(a.nickname || a.type_designator) && (
                      <Text style={[styles.rowNickname, { color: tokens.t3, fontSize: fs(12.5) }]}>
                        {[a.nickname, a.type_designator ? `Type ${a.type_designator}` : null].filter(Boolean).join(' · ')}
                      </Text>
                    )}
                  </View>
                  <Pressable onPress={(e) => { e.stopPropagation(); setEditingAircraft(a) }} hitSlop={10} style={{ marginRight: 14 }}>
                    <Icon name="pencil" size={17} color={tokens.t3} />
                  </Pressable>
                  <Pressable onPress={(e) => { e.stopPropagation(); handleRemove(a.id) }} hitSlop={10} style={{ marginRight: 4 }}>
                    <Icon name="trash" size={17} color={tokens.t3} />
                  </Pressable>
                  <Icon name="chevron.right" size={14} color={tokens.t4} />
                </Pressable>
              ))}
            </View>
          )}

          <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
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
                <Text style={styles.addButtonText}>Add Aircraft</Text>
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
              <Icon name="xmark" size={18} color={tokens.t3} />
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
            {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.addButtonText}>Save Changes</Text>}
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
      <Icon name="chevron.down" size={14} color={tokens.t4} />
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
  intro: { lineHeight: 18, marginBottom: 16 },
  empty: { textAlign: 'center', paddingVertical: 20 },
  list: { borderRadius: 12, borderWidth: 1, marginBottom: 20, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  rowMake: { fontWeight: '600' },
  rowNickname: { marginTop: 2 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 },
  formCard: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  suggestBox: { borderWidth: 1, borderRadius: 8, marginTop: 4, overflow: 'hidden' },
  suggestRow: { paddingHorizontal: 12, paddingVertical: 9 },
  typeHint: { lineHeight: 15, marginTop: -4 },
  addButton: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  addButtonText: { color: '#fff', fontWeight: '600', fontSize: 14.5 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, gap: 4 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { fontWeight: '700' },
})
