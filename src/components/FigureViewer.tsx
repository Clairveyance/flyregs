import { Modal, View, Text, Image, Pressable, ScrollView, StyleSheet, Dimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import type { AcFigure } from '@/types'

// Full-screen viewer for a rendered Figure/Table page image. Pinch-zoom is a
// native ScrollView capability on iOS (minimumZoomScale/maximumZoomScale) —
// no extra gesture library needed. Zoom is a no-op on web, where the image
// just displays at fit-to-screen; that's an acceptable gap since the real
// target is on-device use.
export function FigureViewer({
  figure,
  onClose,
}: {
  figure: AcFigure | null
  onClose: () => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const { width, height } = Dimensions.get('window')

  return (
    <Modal visible={!!figure} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={[styles.headerText, { fontSize: fs(13.5) }]} numberOfLines={1}>
            {figure?.label}
            {figure?.caption ? ` — ${figure.caption}` : ''}
          </Text>
          <Pressable onPress={onClose} hitSlop={14} style={styles.closeBtn}>
            <Icon name="xmark" size={20} color="#fff" />
          </Pressable>
        </View>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          minimumZoomScale={1}
          maximumZoomScale={4}
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          {figure && (
            <Image
              source={{ uri: figure.image_url }}
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    height: 44,
    gap: 12,
  },
  headerText: { color: '#fff', fontWeight: '600', flex: 1 },
  closeBtn: { padding: 6 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
})
