import { Stack, router } from 'expo-router'
import { View, StyleSheet, Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { StatusBar } from 'expo-status-bar'
import * as Notifications from 'expo-notifications'
import { useFonts } from 'expo-font'
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter'
import { Montserrat_400Regular } from '@expo-google-fonts/montserrat'
import { Pacifico_400Regular } from '@expo-google-fonts/pacifico'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useState } from 'react'
import { ThemeProvider, useTheme } from '@/context/theme'
import { AuthProvider } from '@/context/auth'
import { DrawerProvider } from '@/context/drawer'
import { ScreenActionsProvider } from '@/context/screenActions'
import { FontScaleProvider } from '@/context/fontScale'
import { BadgeLifespanProvider } from '@/context/badgeLifespan'
import { ResponsiveProvider } from '@/context/responsive'
import { Drawer } from '@/components/Drawer'
import { PersistentTabBar } from '@/components/PersistentTabBar'
import { AnimatedSplash } from '@/components/AnimatedSplash'
import { ShareCardProvider } from '@/components/ShareCardCapture'
import { AircraftDowngradeGate } from '@/components/AircraftDowngradeGate'
import { ConfirmProvider } from '@/components/ConfirmDialog'
import { IPadSplitViewExperiment } from '@/components/IPadSplitViewExperiment'
import { initSentry } from '@/lib/sentry'

// Phase-1 SplitView proof-of-mechanism, dev-only, defaults off -- see
// flyregs_ipad_plan.md. When on (iOS only; SplitView has no Android/web
// native backing), this REPLACES the entire real app tree below with an
// isolated 3-column demo. Never on in a real build unless deliberately set.
const IPAD_SPLITVIEW_EXPERIMENT = process.env.EXPO_PUBLIC_IPAD_SPLITVIEW_EXPERIMENT === '1'

// Prevent the native splash screen from auto-hiding (no-op on web)
if (Platform.OS !== 'web') {
  SplashScreen.preventAutoHideAsync()
}

initSentry()

function AppShell({ children }: { children: React.ReactNode }) {
  const { resolved } = useTheme()
  const [splashDone, setSplashDone] = useState(false)

  // On web, fonts are already loaded via global.css Google Fonts import — skip useFonts
  const [fontsLoaded] = useFonts(
    Platform.OS === 'web'
      ? {}
      : {
          Inter_400Regular,
          Inter_500Medium,
          Inter_600SemiBold,
          Inter_700Bold,
          Montserrat_400Regular,
          Pacifico_400Regular,
        }
  )

  useEffect(() => {
    if (fontsLoaded && Platform.OS !== 'web') {
      SplashScreen.hideAsync()
    }
  }, [fontsLoaded])

  // Routes a tapped notification to its content. DailyReg and Duels
  // carry a routable payload today (AC/AD update alerts send
  // documentNumbers/adNumbers with no `type` field and predate this
  // listener entirely -- deliberately left as-is here rather than
  // retrofitting their routing as a side effect of this feature; that's
  // its own gap, tracked separately).
  useEffect(() => {
    if (Platform.OS === 'web') return
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      // sourceType is the current field (get_reg_of_the_day now rotates
      // P/CG + FAR + AIM, not just P/CG) -- pcgSlug/no-sourceType kept as a
      // fallback so an already-delivered/queued notification sent by the
      // previous version of send-reg-of-day.mjs before this shipped still
      // routes correctly instead of silently no-op'ing.
      const data = response.notification.request.content.data as
        { type?: string; slug?: string; sourceType?: string; pcgSlug?: string; challengeId?: string; token?: string } | undefined
      if (data?.type === 'reg_of_day' && data.slug && data.sourceType) {
        router.push(`/${data.sourceType}/${data.slug}` as any)
      } else if (data?.type === 'reg_of_day' && data.pcgSlug) {
        router.push(`/pcg/${data.pcgSlug}` as any)
      } else if (data?.type === 'duel' && data.challengeId) {
        router.push(`/challenges/${data.challengeId}` as any)
      } else if (data?.type === 'collab-invite' && data.token) {
        router.push(`/join/${data.token}` as any)
      }
    })
    return () => sub.remove()
  }, [])

  // RC, real device (web preview): "every time I click it [the pencil/
  // circle annotate tool] to circle things for you, it blows the screen up
  // huge and I can't edit." WebKit's double-tap-to-zoom gesture -- live by
  // default, uncapped, on every page -- reads a quick double-tap-style
  // interaction (exactly what circling something on a screenshot involves)
  // as "zoom in," with nothing capping how far. Tried fixing this via a
  // custom app/+html.tsx viewport override first, but that mechanism only
  // applies to `expo export`'s static-render path, not the interactive
  // `expo start --web` dev server this Preview actually runs -- confirmed
  // live via direct curl, unaffected even after a full server restart.
  // touch-action:manipulation on the root disables double-tap-zoom (and
  // the ~300ms tap-delay browsers use to detect it) directly via CSS,
  // which the normal web bundle DOES hot-reload, so it works in both dev
  // preview and any real build regardless of which HTML template ends up
  // serving the page.
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const style = document.createElement('style')
    style.textContent = 'html, body, #root { touch-action: manipulation; }'
    document.head.appendChild(style)
    return () => { document.head.removeChild(style) }
  }, [])

  // On web, always render (fonts come from CSS). On native, wait for fonts.
  if (!fontsLoaded && Platform.OS !== 'web') return null

  return (
    <GestureHandlerRootView style={styles.root}>
      {children}
      <PersistentTabBar />
      <Drawer />
      <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      {!splashDone && <AnimatedSplash onDone={() => setSplashDone(true)} />}
    </GestureHandlerRootView>
  )
}

export default function RootLayout() {
  if (IPAD_SPLITVIEW_EXPERIMENT && Platform.OS === 'ios') {
    return <IPadSplitViewExperiment />
  }

  return (
    <ThemeProvider>
      <ResponsiveProvider>
      <FontScaleProvider>
      <BadgeLifespanProvider>
      <AuthProvider>
        <ShareCardProvider>
        <DrawerProvider>
        <ScreenActionsProvider>
        <ConfirmProvider>
          <AppShell>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="series/[prefix]" />
              <Stack.Screen name="ac/[id]" />
              <Stack.Screen name="auth" options={{ presentation: 'modal' }} />
              <Stack.Screen name="paywall" options={{ presentation: 'modal' }} />
              <Stack.Screen name="pdf-viewer" options={{ presentation: 'modal' }} />
              <Stack.Screen name="account" />
              <Stack.Screen name="manage-subscription" />
              <Stack.Screen name="my-aircraft" />
              <Stack.Screen name="faq" />
              <Stack.Screen name="feedback" />
              <Stack.Screen name="about" />
              <Stack.Screen name="privacy" />
              <Stack.Screen name="terms" />
            </Stack>
            {/* Mounted at the root, not on My Aircraft, deliberately -- a
                downgrade is processed in Apple's subscription settings,
                outside this app entirely, so the only chance to catch the
                user is wherever they happen to be next. See the component
                for the full reasoning. */}
            <AircraftDowngradeGate />
          </AppShell>
        </ConfirmProvider>
        </ScreenActionsProvider>
        </DrawerProvider>
        </ShareCardProvider>
      </AuthProvider>
      </BadgeLifespanProvider>
      </FontScaleProvider>
      </ResponsiveProvider>
    </ThemeProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
})
