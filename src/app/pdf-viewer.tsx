import { useState } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Platform } from 'react-native'
import { WebView } from 'react-native-webview'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { useAllowRotation } from '@/lib/orientation'

// Renders the AC's original PDF fully in-app instead of handing the raw URL
// to an external/system browser sheet. That used to go through
// expo-web-browser's openBrowserAsync(), which is Pro-gated correctly but
// still puts up a native SFSafariViewController / Custom Tab -- Apple's own
// share/copy-link button lives in that chrome, completely outside this app's
// control, so a legitimate Pro user could forward the raw, un-gated PDF link
// to anyone with zero app involvement (confirmed as the real mechanism
// behind a beta tester's shared AC ending up openable by someone who never
// had the app at all). A plain WebView has no such affordance -- the only
// way out of this screen is the close button below.
export default function PDFViewerScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const { url, title } = useLocalSearchParams<{ url: string; title?: string }>()
  const [loading, setLoading] = useState(true)
  // Rotation is normally locked app-wide (app.json) -- allowed here only,
  // and only while this screen is actually open, so leaving (however the
  // user leaves -- the close button, a system back gesture, etc.) always
  // snaps the rest of the app back to portrait, never leaves it sideways.
  useAllowRotation(true)

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 14), borderBottomColor: tokens.bdr }]}>
        <Text style={[styles.title, { color: tokens.t1, fontSize: fs(15) }]} numberOfLines={1}>
          {title || 'Original PDF'}
        </Text>
        <Pressable onPress={() => router.dismiss()} hitSlop={10} style={styles.closeBtn}>
          <Icon name="xmark" size={18} color={tokens.t3} />
        </Pressable>
      </View>

      {Platform.OS === 'web' ? (
        <View style={styles.center}>
          <Text style={{ color: tokens.t3, fontSize: fs(14) }}>
            PDF viewing isn't available in the browser preview.
          </Text>
        </View>
      ) : (
        <>
          <WebView
            // Android's WebView (unlike iOS's WKWebView) has no reliable
            // built-in PDF renderer -- loading a raw PDF URL directly there
            // routinely falls through to a download/"open with" flow
            // instead of rendering inline (a well-known react-native-
            // webview gotcha, not something specific to any one PDF host).
            // Google's public docs-viewer proxy is the standard workaround:
            // it fetches and renders the PDF as an embedded HTML view, so
            // the WebView always has real HTML to show regardless of the
            // PDF's own origin/headers. iOS keeps the direct URL since
            // WKWebView renders PDFs natively and reliably there.
            source={{ uri: Platform.OS === 'android' ? `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(url)}` : url }}
            style={styles.webview}
            onLoadEnd={() => setLoading(false)}
            startInLoadingState={false}
          />
          {loading && (
            <View style={[styles.center, StyleSheet.absoluteFill, { backgroundColor: tokens.bg }]}>
              <ActivityIndicator color={tokens.blu} />
            </View>
          )}
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 12,
    paddingHorizontal: 44,
    borderBottomWidth: 1,
  },
  title: { fontWeight: '600' },
  closeBtn: { position: 'absolute', right: 16, bottom: 12 },
  webview: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
})
