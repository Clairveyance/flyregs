import { useEffect, useState } from 'react'
import { Modal, View, Text, Image, Pressable, ScrollView, StyleSheet, ActivityIndicator, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { useAllowRotation } from '@/lib/orientation'
import { useGatedCachedImage } from '@/lib/imageCache'
import type { FormulaRef } from '@/types'

// Full-screen viewer for a flagged formula page image. Deliberately a
// standalone copy of FigureViewer.tsx rather than a shared component -- this
// keeps the Formulas-to-Verify feature fully independent of the Figures &
// Tables pipeline (separate table, separate Storage bucket, separate UI),
// per the explicit ask to never risk the existing T&F extraction/display
// logic when adding this.
export function FormulaRefViewer({
  formulaRef,
  onClose,
}: {
  formulaRef: FormulaRef | null
  onClose: () => void
}) {
  const { tokens, redShift } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  // useWindowDimensions (not Dimensions.get, a one-time read) so the image
  // actually reflows to fill the new width/height when the device rotates
  // while this viewer is open — see useAllowRotation below.
  const { width, height } = useWindowDimensions()
  useAllowRotation(!!formulaRef)
  // Local cached copy if this AC was downloaded for offline reading (see
  // handleDownload in ac/[id].tsx), otherwise a freshly-signed URL for the
  // private ac-formula-refs bucket -- null (renders a spinner below) for
  // the brief window before either is ready.
  const imageUri = useGatedCachedImage(formulaRef?.id ?? null, formulaRef?.image_url ?? null)

  // Same fix as FigureViewer.tsx: a scraped page image can print its
  // content sideways relative to its own portrait bounding box, which
  // following the device's orientation can never correct. Manual per-image
  // counter-rotation, reset on every formulaRef change/close.
  const [manualRotation, setManualRotation] = useState(0)
  useEffect(() => { setManualRotation(0) }, [formulaRef?.id])
  const rotated90 = manualRotation === 90 || manualRotation === 270
  const boxWidth = width
  const boxHeight = height - insets.top - 90

  return (
    <Modal
      visible={!!formulaRef}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      // Same fix as FigureViewer.tsx: RN's <Modal> defaults to portrait-only
      // on iOS regardless of the app's own orientation lock/unlock, so it
      // needs its own supportedOrientations to actually rotate.
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
    >
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={[styles.headerText, { fontSize: fs(13.5) }]} numberOfLines={1}>
            {formulaRef?.label}
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
            <Icon name="xmark" size={fs(20)} color={redShift ? '#D6553A' : '#fff'} />
          </Pressable>
        </View>
        {formulaRef?.note && (
          <Text style={[styles.noteText, { fontSize: fs(12.5) }, redShift && { color: '#D6553A' }]} numberOfLines={3}>
            {formulaRef.note}
          </Text>
        )}
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          minimumZoomScale={1}
          maximumZoomScale={4}
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          {formulaRef && (imageUri ? (
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
  noteText: { color: 'rgba(255,255,255,0.7)', paddingHorizontal: 16, paddingBottom: 8 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
})
