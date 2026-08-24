import { useState } from 'react'
import { View, Text, Pressable, Modal, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { addRating, removeRating, RATING_GROUPS, RATING_LABELS, RatingCode } from '@/lib/profileRatings'

// Ratings used to be editable from Account AND displayed on Profile, with
// Profile's "+ Add Rating" doing nothing but router.push('/account') — so
// tapping it on your own profile threw you out to a settings screen. Ratings
// are a Community/Profile concept (they show next to your callsign to other
// pilots), so the editor now lives there and only there. This is the shared
// sheet; Account no longer has a ratings section at all.

export function RatingPicker({
  visible,
  userId,
  ratings,
  onClose,
  onChange,
}: {
  visible: boolean
  userId: string
  ratings: RatingCode[]
  onClose: () => void
  /** Called with the new full list after a successful add/remove. */
  onChange: (next: RatingCode[]) => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const [busy, setBusy] = useState<RatingCode | null>(null)

  const toggle = async (code: RatingCode) => {
    if (busy) return
    setBusy(code)
    try {
      if (ratings.includes(code)) {
        await removeRating(userId, code)
        onChange(ratings.filter((r) => r !== code))
      } else {
        await addRating(userId, code)
        onChange([...ratings, code])
      }
    } catch {
      // Leave the list as-is; the row simply doesn't flip.
    }
    setBusy(null)
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: tokens.bg }]}>
        <View style={[styles.header, { borderBottomColor: tokens.bdr }]}>
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(15.5) }]}>Ratings</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Icon name="xmark" size={fs(18)} color={tokens.t3} />
          </Pressable>
        </View>
        <Text style={[styles.help, { color: tokens.t3, fontSize: fs(12), lineHeight: fs(12) * 1.42 }]}>
          Self-reported — shown alongside your callsign wherever it appears to other players.
          Not verified by FlyRegs.
        </Text>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body}>
          {RATING_GROUPS.map((group) => (
            <View key={group.label} style={{ marginBottom: 18 }}>
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                {group.label.toUpperCase()}
              </Text>
              {group.codes.map((code) => {
                const active = ratings.includes(code)
                return (
                  <Pressable
                    key={code}
                    style={[styles.row, { borderBottomColor: tokens.bdr }]}
                    onPress={() => toggle(code)}
                    disabled={busy === code}
                  >
                    <Text style={[styles.rowText, { color: tokens.t1, fontSize: fs(14.5) }]}>
                      {RATING_LABELS[code]}
                    </Text>
                    {busy === code ? (
                      <ActivityIndicator size="small" color={tokens.t3} />
                    ) : active ? (
                      <Icon name="checkmark.circle.fill" size={fs(20)} color={tokens.gold} />
                    ) : (
                      <View style={[styles.checkEmpty, { borderColor: tokens.bdr }]} />
                    )}
                  </Pressable>
                )
              })}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { height: '76%', borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontWeight: '700' },
  // lineHeight NOT set here -- always overridden inline with fs(12) * 1.42
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  help: { paddingHorizontal: 18, paddingTop: 12 },
  body: { padding: 18, paddingBottom: 40 },
  groupLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, paddingRight: 12 },
  checkEmpty: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5 },
})
