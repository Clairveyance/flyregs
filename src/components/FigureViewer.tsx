import { useEffect, useState } from 'react'
import { Modal, View, Text, Image, Pressable, ScrollView, StyleSheet, ActivityIndicator, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { useAllowRotation } from '@/lib/orientation'
import { useGatedCachedImage } from '@/lib/imageCache'
import type { AcFigure } from '@/types'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// Full-screen viewer for a rendered Figure/Table page image. Pinch-zoom is a
// native ScrollView capability on iOS (minimumZoomScale/maximumZoomScale) —
// no extra gesture library needed. Zoom is a no-op on web, where the image
// just displays at fit-to-screen; that's an acceptable gap since the real
// target is on-device use.
export function FigureViewer({
  figure,
  figures,
  onNavigate,
  onClose,
}: {
  figure: AcFigure | null
  // Sibling figures within the same document, in display order — RC: "when
  // in any Figure inside a reg, we should have Next Fig/Prev Fig buttons so
  // users don't have to X out of one just to flip through the Figures
  // inside that reg." Optional so every existing call site keeps compiling
  // untouched; the footer below just doesn't render without it.
  figures?: AcFigure[]
  onNavigate?: (figure: AcFigure) => void
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
  const figIdx = figure && figures ? figures.findIndex((f) => f.id === figure.id) : -1
  const hasPrev = figIdx > 0
  const hasNext = figIdx >= 0 && !!figures && figIdx < figures.length - 1
  const goPrev = () => { if (hasPrev && figures && onNavigate) onNavigate(figures[figIdx - 1]) }
  const goNext = () => { if (hasNext && figures && onNavigate) onNavigate(figures[figIdx + 1]) }
  // Local cached copy if this AC was downloaded for offline reading (see
  // handleDownload in ac/[id].tsx), otherwise a freshly-signed URL for the
  // private ac-figures bucket -- null (renders a spinner below) for the
  // brief window before either is ready, since the stored image_url itself
  // isn't directly fetchable anymore.
  const imageUri = useGatedCachedImage(figure?.id ?? null, figure?.image_url ?? null)

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
  // Figure label + caption can run long and get cut off the same way FAR
  // Part titles do -- same hook/card pair as far/index.tsx's own long-press
  // preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview } = useLongPressPreview()
  const rotated90 = manualRotation === 90 || manualRotation === 270
  const showNav = !!figures && figures.length > 1
  const boxWidth = width
  const boxHeight = height - insets.top - 56 - (showNav ? 52 : 0)

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
          <Pressable
            style={{ flex: 1 }}
            onLongPress={(e) => showPreview(`${figure?.label ?? ''}${figure?.caption ? ` — ${figure.caption}` : ''}`, e)}
            onPressOut={hidePreview}
            delayLongPress={350}
          >
            <Text style={[styles.headerText, { fontSize: fs(13.5) }]} numberOfLines={1}>
              {figure?.label}
              {figure?.caption ? ` — ${figure.caption}` : ''}
            </Text>
          </Pressable>
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
          {figure && (imageUri ? (
            <Image
              source={{ uri: imageUri }}
              style={{
                width: rotated90 ? boxHeight : boxWidth,
                height: rotated90 ? boxWidth : boxHeight,
                transform: [{ rotate: `${manualRotation}deg` }],
              }}
              resizeMode="contain"
            />
          ) : (
            <ActivityIndicator color="#fff" size="large" />
          ))}
        </ScrollView>
        {showNav && (
          <View style={[styles.navBar, { paddingBottom: insets.bottom || 8 }]}>
            <Pressable
              onPress={goPrev}
              disabled={!hasPrev}
              hitSlop={10}
              style={[styles.navBtn, !hasPrev && styles.navBtnDisabled]}
            >
              <Icon name="chevron.left" size={fs(15)} color="#fff" />
              <Text style={[styles.navText, { fontSize: fs(13) }]}>Prev Fig</Text>
            </Pressable>
            <Text style={[styles.navCount, { fontSize: fs(12) }]}>{figIdx + 1} of {figures!.length}</Text>
            <Pressable
              onPress={goNext}
              disabled={!hasNext}
              hitSlop={10}
              style={[styles.navBtn, styles.navBtnRight, !hasNext && styles.navBtnDisabled]}
            >
              <Text style={[styles.navText, { fontSize: fs(13) }]}>Next Fig</Text>
              <Icon name="chevron.right" size={fs(15)} color="#fff" />
            </Pressable>
          </View>
        )}
      </View>
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
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
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.15)',
  },
  navBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 8 },
  navBtnRight: { flexDirection: 'row-reverse' },
  navBtnDisabled: { opacity: 0.3 },
  navText: { color: '#fff', fontWeight: '600' },
  navCount: { color: 'rgba(255,255,255,0.6)', fontWeight: '500' },
})
