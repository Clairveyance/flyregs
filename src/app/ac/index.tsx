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
    if (typeof id !== 'string') {
      router.replace('/')
      return
    }
    router.replace(hl ? `/ac/${id}?hlText=${encodeURIComponent(hl)}` : `/ac/${id}`)
  }, [id, hl])

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.bg }}>
      <ActivityIndicator size="large" color={tokens.blu} />
    </View>
  )
}
