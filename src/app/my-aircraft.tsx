import { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'

// The actual payoff of the AD expansion, per explicit direction: a pilot/
// owner/mechanic only cares about the ~15-20 ADs issued per week that touch
// an aircraft they actually fly, not a firehose across the full 17,000+
// corpus. This lightweight make/model list (not a full N-number/registry
// lookup — deliberately kept simple) is what a future AD-alerts job matches
// new/updated ADs against.
interface UserAircraft {
  id: string
  make: string
  model: string
  nickname: string | null
}

export default function MyAircraftScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro } = useAuth()
  const [aircraft, setAircraft] = useState<UserAircraft[]>([])
  const [loading, setLoading] = useState(true)
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [nickname, setNickname] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    if (!session) {
      setLoading(false)
      return
    }
    supabase
      .from('user_aircraft')
      .select('id, make, model, nickname')
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
    const trimmedMake = make.trim()
    const trimmedModel = model.trim()
    if (!trimmedMake || !trimmedModel) {
      Alert.alert('Make and model required', 'Enter both the aircraft make and model.')
      return
    }
    setSaving(true)
    const { error } = await supabase
      .from('user_aircraft')
      .insert({ user_id: session.user.id, make: trimmedMake, model: trimmedModel, nickname: nickname.trim() || null })
    setSaving(false)
    if (error) {
      Alert.alert('Could not add aircraft', error.message)
      return
    }
    setMake('')
    setModel('')
    setNickname('')
    load()
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
                <View
                  key={a.id}
                  style={[styles.row, i < aircraft.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowMake, { color: tokens.t1, fontSize: fs(14.5) }]}>
                      {a.make} {a.model}
                    </Text>
                    {a.nickname && <Text style={[styles.rowNickname, { color: tokens.t3, fontSize: fs(12.5) }]}>{a.nickname}</Text>}
                  </View>
                  <Pressable onPress={() => handleRemove(a.id)} hitSlop={10}>
                    <Icon name="trash" size={17} color={tokens.t3} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>ADD AIRCRAFT</Text>
          <View style={[styles.formCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
            <TextInput
              value={make}
              onChangeText={setMake}
              placeholder="Make (e.g. Cessna)"
              placeholderTextColor={tokens.t3}
              style={[styles.input, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }]}
            />
            <TextInput
              value={model}
              onChangeText={setModel}
              placeholder="Model (e.g. 172S)"
              placeholderTextColor={tokens.t3}
              style={[styles.input, { color: tokens.t1, fontSize: fs(14.5), borderColor: tokens.bdr }]}
            />
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
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  intro: { lineHeight: 18, marginBottom: 16 },
  empty: { textAlign: 'center', paddingVertical: 20 },
  list: { borderRadius: 12, borderWidth: 1, marginBottom: 20, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 },
  rowMake: { fontWeight: '600' },
  rowNickname: { marginTop: 2 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 },
  formCard: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  addButton: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  addButtonText: { color: '#fff', fontWeight: '600', fontSize: 14.5 },
})
