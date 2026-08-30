import { Image, View, ActivityIndicator, StyleProp, ViewStyle, ImageStyle } from 'react-native'
import { useGatedCachedImage } from '@/lib/imageCache'
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
  const uri = useGatedCachedImage(id, imageUrl)
  if (!uri) {
    return (
      <View style={[style as StyleProp<ViewStyle>, { alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.bg3 }]}>
        <ActivityIndicator color={tokens.t3} />
      </View>
    )
  }
  return <Image source={{ uri }} style={style} resizeMode="cover" />
}
