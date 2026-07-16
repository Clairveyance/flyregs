import { Modal, View, Text, Image, Pressable, ActivityIndicator, StyleSheet, Platform } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { AVATAR_PRESETS, AvatarPreset } from '@/lib/avatarPresets'

// Combines what used to be two separate small controls on the Account
// avatar (a tiny edit badge that popped a native Alert.alert action sheet,
// and a separate tiny expand badge that opened a read-only ImagePreviewModal)
// into one large popup, centered on screen: the photo shown big, with
// Take Photo / Choose from Library / preset swatches as in-modal buttons,
// and Cancel/Done in the header to close. Picking a photo or a preset still
// saves immediately (expo-image-picker's own crop step is the only "confirm"
// gate for a photo; a preset has no separate confirm step at all) -- Cancel
// and Done both just close the popup, since there's no separate
// staged/uncommitted state to discard.

interface Props {
  visible: boolean
  avatarUrl: string | null
  preset: AvatarPreset | null
  initial: string
  busy: boolean
  onTakePhoto: () => void
  onChooseLibrary: () => void
  onSelectPreset: (id: string) => void
  onRemovePhoto: () => void
  onDone: () => void
}

export function AvatarEditModal({
  visible,
  avatarUrl,
  preset,
  initial,
  busy,
  onTakePhoto,
  onChooseLibrary,
  onSelectPreset,
  onRemovePhoto,
  onDone,
}: Props) {
  const { tokens } = useTheme()
  const fs = useFS()
  const hasAvatar = !!avatarUrl || !!preset

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDone}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <View style={[styles.header, { borderBottomColor: tokens.bdr }]}>
            <Pressable onPress={onDone} hitSlop={6}>
              <Text style={[styles.cancelText, { color: tokens.t2, fontSize: fs(14.5) }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.headerTitle, { color: tokens.t1, fontSize: fs(16) }]}>Profile Photo</Text>
            <Pressable onPress={onDone} style={[styles.doneBtn, { backgroundColor: tokens.blu }]} hitSlop={6}>
              <Text style={[styles.doneBtnText, { fontSize: fs(13.5) }]}>Done</Text>
            </Pressable>
          </View>

          <View style={styles.photoWrap}>
            <View style={[styles.photoCircle, { backgroundColor: preset?.color ?? tokens.blu }]}>
              {busy ? (
                <ActivityIndicator color="#fff" size="large" />
              ) : avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.photo} />
              ) : preset ? (
                <Icon name={preset.icon} size={84} color="#fff" />
              ) : (
                <Text style={styles.photoInitial}>{initial}</Text>
              )}
            </View>
          </View>

          <View style={styles.actions}>
            {Platform.OS !== 'web' && (
              <Pressable
                style={[styles.actionBtn, { borderColor: tokens.bdr }]}
                onPress={onTakePhoto}
                disabled={busy}
              >
                <Icon name="camera.fill" size={16} color={busy ? tokens.t4 : tokens.t1} />
                <Text style={[styles.actionText, { color: busy ? tokens.t4 : tokens.t1, fontSize: fs(14.5) }]}>
                  Take Photo
                </Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.actionBtn, { borderColor: tokens.bdr }]}
              onPress={onChooseLibrary}
              disabled={busy}
            >
              <Icon name="photo.fill" size={16} color={busy ? tokens.t4 : tokens.t1} />
              <Text style={[styles.actionText, { color: busy ? tokens.t4 : tokens.t1, fontSize: fs(14.5) }]}>
                Choose from Library
              </Text>
            </Pressable>
            {hasAvatar && (
              <Pressable
                style={[styles.actionBtn, { borderColor: tokens.bdr }]}
                onPress={onRemovePhoto}
                disabled={busy}
              >
                <Icon name="trash" size={16} color={busy ? tokens.t4 : tokens.red} />
                <Text style={[styles.actionText, { color: busy ? tokens.t4 : tokens.red, fontSize: fs(14.5) }]}>
                  Remove Photo
                </Text>
              </Pressable>
            )}
          </View>

          <View style={[styles.presetSection, { borderTopColor: tokens.bdr }]}>
            <Text style={[styles.presetLabel, { color: tokens.t3, fontSize: fs(12) }]}>OR PICK A PRESET</Text>
            <View style={styles.presetRow}>
              {AVATAR_PRESETS.map((p) => {
                const selected = preset?.id === p.id
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => onSelectPreset(p.id)}
                    disabled={busy}
                    style={[
                      styles.presetSwatch,
                      { backgroundColor: p.color, opacity: busy ? 0.5 : 1 },
                      selected && { borderWidth: 2, borderColor: tokens.t1 },
                    ]}
                  >
                    <Icon name={p.icon} size={18} color="#fff" />
                  </Pressable>
                )
              })}
            </View>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 20,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { flex: 1, textAlign: 'center', fontWeight: '600' },
  cancelText: { fontWeight: '500' },
  doneBtn: { borderRadius: 16, paddingHorizontal: 16, paddingVertical: 7 },
  doneBtnText: { color: '#fff', fontWeight: '600' },
  photoWrap: { alignItems: 'center', paddingVertical: 28 },
  photoCircle: {
    width: 200,
    height: 200,
    borderRadius: 100,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photo: { width: 200, height: 200, borderRadius: 100 },
  photoInitial: { color: '#fff', fontWeight: '700', fontSize: 72 },
  actions: { paddingHorizontal: 18, paddingBottom: 16, gap: 10 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
  },
  actionText: { fontWeight: '600' },
  presetSection: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 20, borderTopWidth: 1 },
  presetLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 10 },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  presetSwatch: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
