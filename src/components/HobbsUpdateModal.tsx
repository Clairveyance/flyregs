import { useState, useEffect } from 'react'
import { View, Text, Pressable, TextInput, Modal, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { useConfirm } from '@/components/ConfirmDialog'
import { setAircraftCurrentHobbs } from '@/lib/aircraftSharing'

// Shared self-reported hobbs/tach editor -- used from the aircraft detail
// screen, the Fleet list row, and Home's quick-update CTA, so all three
// write through the exact same validation + DB path instead of drifting.
// See sync/migrations_hobbs_tracking.sql.
//
// Body is split out from the <Modal> wrapper so Home's picker sheet can
// render it *inside its own already-presented Modal* instead of mounting a
// second native <Modal> on top. RC, real device: two RN <Modal>s both
// visible at once works fine on web (just an overlay) but on iOS each one
// is a real UIKit modal presentation -- stacking a second on a first
// silently ate all touches, so the editor looked like it did nothing.
export function HobbsUpdateBody({
  aircraftId, initialHours, updatedAt, onClose, onSaved,
}: {
  aircraftId: string
  initialHours: number | null
  updatedAt: string | null
  onClose: () => void
  onSaved: (hours: number | null) => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const confirm = useConfirm()
  const [text, setText] = useState(initialHours != null ? String(initialHours) : '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (saving) return
    const trimmed = text.trim()
    const hours = trimmed === '' ? null : parseFloat(trimmed)
    if (trimmed !== '' && (hours == null || isNaN(hours) || hours < 0)) {
      confirm({ title: 'Invalid hours', message: 'Enter a positive number, or leave it blank to clear.', cancelLabel: null })
      return
    }
    setSaving(true)
    try {
      await setAircraftCurrentHobbs(aircraftId, hours)
      onSaved(hours)
    } catch (e: any) {
      confirm({ title: 'Could not save', message: e?.message ?? 'Unknown error', cancelLabel: null })
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={[styles.card, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: tokens.t1, fontSize: fs(16) }]}>Current Hobbs / Tach</Text>
        <Pressable onPress={onClose} hitSlop={10}>
          <Icon name="xmark" size={fs(18)} color={tokens.t3} />
        </Pressable>
      </View>
      <Text style={{ color: tokens.t3, fontSize: fs(12.5), marginBottom: 4 }}>
        Self-reported — used to compare against any reminder's usage-based due mark.
      </Text>
      <View style={[styles.inputRow, { borderColor: tokens.bdr }]}>
        <TextInput
          value={text}
          onChangeText={(t) => setText(t.replace(/[^0-9.]/g, ''))}
          placeholder="e.g. 1842.3"
          placeholderTextColor={tokens.t3}
          keyboardType="decimal-pad"
          style={{ flex: 1, color: tokens.t1, fontSize: ifs(14.5), paddingVertical: 12 }}
          autoFocus
        />
        <Text style={{ color: tokens.t3, fontSize: fs(13) }}>hrs</Text>
      </View>
      {updatedAt && (
        <Text style={{ color: tokens.t4, fontSize: fs(11.5) }}>
          Last updated {new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </Text>
      )}
      <Pressable style={[styles.saveBtn, { backgroundColor: tokens.blu, opacity: saving ? 0.5 : 1 }]} onPress={handleSave} disabled={saving}>
        <Text style={styles.saveBtnText}>Save</Text>
      </Pressable>
    </View>
  )
}

export function HobbsUpdateModal({
  visible, aircraftId, initialHours, updatedAt, onClose, onSaved,
}: {
  visible: boolean
  aircraftId: string
  initialHours: number | null
  updatedAt: string | null
  onClose: () => void
  onSaved: (hours: number | null) => void
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      {/* RC, real device: the numeric keypad covered the input box AND the
          Save button entirely, leaving only the bare keypad on screen --
          this Modal pins its content to the bottom via justifyContent:
          'flex-end', and without KeyboardAvoidingView that content never
          shifts up when the keyboard opens (invisible on web, which has no
          real OS keyboard to cover anything). Matches the same wrapper
          FolderPicker.tsx/FolderSelectSheet.tsx already use for this exact
          shape of bottom-sheet-with-text-input. */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.backdrop}>
        {visible && (
          <HobbsUpdateBody
            aircraftId={aircraftId}
            initialHours={initialHours}
            updatedAt={updatedAt}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  card: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, gap: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  title: { fontWeight: '700' },
  inputRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12 },
  saveBtn: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  saveBtnText: { color: '#fff', fontWeight: '600', fontSize: 14.5 },
})
