import { Modal, View, Image, Pressable, ScrollView, StyleSheet, Dimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '@/components/Icon'

// Full-screen tap-to-enlarge preview for a single image (e.g. a profile
// photo) — same pinch-zoom-via-native-ScrollView pattern as FigureViewer,
// stripped down since there's no caption/label to show, just the photo and
// a close button.
export function ImagePreviewModal({
  uri,
  onClose,
}: {
  uri: string | null
  onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  const { width, height } = Dimensions.get('window')

  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <Pressable onPress={onClose} hitSlop={14} style={styles.closeBtn}>
          <Icon name="xmark" size={20} color="#fff" />
        </Pressable>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          minimumZoomScale={1}
          maximumZoomScale={4}
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          {uri && (
            <Image
              source={{ uri }}
              style={{ width, height: height - insets.top - 56 }}
              resizeMode="contain"
            />
          )}
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'rgba(0,0,0,0.97)' },
  closeBtn: { alignSelf: 'flex-end', padding: 14 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
})
