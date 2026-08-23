import { useEffect } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useTheme } from '@/context/theme'

// A Universal Link tap on a shared AC opens https://flyregs.com/ac/?id=...
// directly (bypassing the website's own JS hand-off, which only runs when
// there's no app installed to intercept the link) -- but that's a query-param
// URL with no path segment, and the app's only real AC route is the dynamic
// ac/[id] segment. This is a thin redirect shim so that shape still resolves
// to the exact same screen the website's JS would have deep-linked to,
// mirroring 01_Website/flyregs-website/ac/index.html's own id/hl handoff.
export default function ACLinkRedirect() {
  const { tokens } = useTheme()
  const { id, hl } = useLocalSearchParams<{ id?: string; hl?: string }>()

  useEffect(() => {
    // dismissTo (not replace) -- same fix as confirm.tsx/reset-password.tsx:
    // this screen is one of the app's Universal Link landing points
    // (app.json pathPrefix "/ac"), reached straight from a background/
    // foreground transition just like those. If some modal (auth, paywall)
    // was already presented when the link was tapped, replace() here would
    // only swap this screen for the target, leaving that modal stacked on
    // top of it, unreachable without a manual dismiss. dismissTo collapses
    // any presented modal/pushed screens on the way to the target, and
    // degrades to the exact same behavior as replace() when there's nothing
    // to collapse (confirmed via expo-router's StackRouter POP_TO handling).
    if (typeof id !== 'string') {
      router.dismissTo('/')
      return
    }
    router.dismissTo(hl ? `/ac/${id}?hlText=${encodeURIComponent(hl)}` : `/ac/${id}`)
  }, [id, hl])

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.bg }}>
      <ActivityIndicator size="large" color={tokens.blu} />
    </View>
  )
}
