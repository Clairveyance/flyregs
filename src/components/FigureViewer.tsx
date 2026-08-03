import { useEffect, useState } from 'react'
import { Modal, View, Text, Image, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { useAllowRotation } from '@/lib/orientation'
import { useCachedImage } from '@/lib/imageCache'
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
  // useWindowDimensions (not Dimensions.get, a one-time read) so the image
  // actually reflows to fill the new width/height when the device rotates
  // while this viewer is open — see useAllowRotation below.
  const { width, height } = useWindowDimensions()
  useAllowRotation(!!figure)
  // Local cached copy if this AC was downloaded for offline reading (see
  // handleDownload in ac/[id].tsx) -- falls back to the live remote URL
  // instantly if nothing's cached yet, so online viewing never regresses.
  const imageUri = useCachedImage(figure?.id ?? null, figure?.image_url ?? null)

  // Some source PDF pages print a figure sideways relative to the page's
  // own portrait bounding box (the scraped page image is portrait, but the
  // diagram inside it is landscape). Following the DEVICE's orientation
  // (useAllowRotation above) can't fix this -- the image's own pixels are
  // still sideways no matter which way the phone is held. This is a manual
  // per-image counter-rotation instead: confirmed live, RC: "could we offer
  // an in-app, on-this-screen, rotation lock button? it should 'timeout'
  // each time that single T&F is closed, not affecting anything else."
  // Resets to 0 on every figure change/close so it never carries over and
  // mis-rotates the NEXT figure, which is likely already right-side-up.
  const [manualRotation, setManualRotation] = useState(0)
  useEffect(() => { setManualRotation(0) }, [figure?.id])
  const rotated90 = manualRotation === 90 || manualRotation === 270
  const boxWidth = width
  const boxHeight = height - insets.top - 56

  return (
    <Modal
      visible={!!figure}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      // React Native's <Modal> defaults to portrait-only on iOS regardless
      // of the app's own orientation lock/unlock (useAllowRotation above) --
      // a modally-presented view controller has its own separate
      // supportedInterfaceOrientations, distinct from the root/pushed-screen
      // one pdf-viewer.tsx relies on. This is the actual reason PDF rotation
      // worked but Figures & Tables didn't: the router-pushed PDF screen
      // followed the root's unlocked mask, this Modal never did.
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
    >
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={[styles.headerText, { fontSize: fs(13.5) }]} numberOfLines={1}>
            {figure?.label}
            {figure?.caption ? ` — ${figure.caption}` : ''}
          </Text>
          <Pressable
            onPress={() => setManualRotation((r) => (r + 90) % 360)}
            hitSlop={14}
            style={styles.closeBtn}
            accessibilityLabel="Rotate image"
          >
            <Icon name="arrow.clockwise" size={fs(20)} color="#fff" />
          </Pressable>
          <Pressable onPress={onClose} hitSlop={14} style={styles.closeBtn}>
            <Icon name="xmark" size={fs(20)} color="#fff" />
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
              source={{ uri: imageUri ?? figure.image_url }}
              style={{
                width: rotated90 ? boxHeight : boxWidth,
                height: rotated90 ? boxWidth : boxHeight,
                transform: [{ rotate: `${manualRotation}deg` }],
              }}
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
