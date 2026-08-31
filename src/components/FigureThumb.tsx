import { Image, View, ActivityIndicator, StyleProp, ViewStyle, ImageStyle } from 'react-native'
import { useGatedCachedImage } from '@/lib/imageCache'
import { Icon } from '@/components/Icon'
import { useTheme } from '@/context/theme'

// Shared figure-thumbnail image, used by aim/[id].tsx and ad/[id].tsx's
// horizontal "Figures & Tables" strip -- both used to render a bare
// `<Image source={{ uri: f.image_url }} />` directly, which is wrong the
// same way a full-screen FigureViewer render of the raw URL would be: the
// storage bucket is private, so `image_url` 401s until resolved/signed, and
// even once network-fetchable it skipped the app's own persistent disk
// cache entirely (see imageCache.ts), re-hitting the network on every
// repeat visit to the same AIM paragraph or AD instead of reading a local
// file like every other figure view in the app already does (FigureViewer,
// ac/[id].tsx's own figure handling). Routes through the identical
// useGatedCachedImage hook FigureViewer uses, one call per thumbnail (a
// hook can't be called inside a loop, hence its own component) -- same
// resolve-then-cache behavior, just at thumbnail size instead of
// full-screen.
export function FigureThumb({
  id, imageUrl, style,
}: {
  id: string
  imageUrl: string
  style: StyleProp<ImageStyle>
}) {
  const { tokens } = useTheme()
  const { uri, failed } = useGatedCachedImage(id, imageUrl)
  if (failed) {
    // A thumbnail that can't be fetched used to sit on the spinner below
    // forever. Deliberately a static placeholder and NOT a Retry button:
    // this whole thumbnail already lives inside a Pressable that opens
    // FigureViewer (see ad/[id].tsx and aim/[id].tsx), so a nested pressable
    // would swallow that tap -- the tap falls through to the viewer, which
    // has the real error state and the real Retry.
    return (
      <View style={[style as StyleProp<ViewStyle>, { alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.bg3 }]}>
        <Icon name="exclamationmark.triangle" size={18} color={tokens.t4} />
      </View>
    )
  }
  if (!uri) {
    return (
      <View style={[style as StyleProp<ViewStyle>, { alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.bg3 }]}>
        <ActivityIndicator color={tokens.t3} />
      </View>
    )
  }
  return <Image source={{ uri }} style={style} resizeMode="cover" />
}
