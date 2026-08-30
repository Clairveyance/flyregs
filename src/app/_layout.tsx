import { Stack, router } from 'expo-router'
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native'
import * as Sentry from '@sentry/react-native'
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

  // Routes a tapped notification to its content. AC/AD/Reminder alerts
  // used to send documentNumbers/adNumbers/reminderId with NO `type` field
  // at all and predated this listener entirely -- found in the 2026-08-29
  // "built but inert" sweep: all three now carry a real `type` (and, for
  // AD/AC, a specific id when only one item was touched), matching the
  // "land directly on the thing" fix already applied to collab-invite below.
  useEffect(() => {
    if (Platform.OS === 'web') return
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      // sourceType is the current field (get_reg_of_the_day now rotates
      // P/CG + FAR + AIM, not just P/CG) -- pcgSlug/no-sourceType kept as a
      // fallback so an already-delivered/queued notification sent by the
      // previous version of send-reg-of-day.mjs before this shipped still
      // routes correctly instead of silently no-op'ing.
      const data = response.notification.request.content.data as
        {
          type?: string; slug?: string; sourceType?: string; pcgSlug?: string; challengeId?: string; token?: string
          documentNumber?: string; userAircraftId?: string; reminderId?: string
        } | undefined
      if (data?.type === 'reg_of_day' && data.slug && data.sourceType) {
        router.push(`/${data.sourceType}/${data.slug}` as any)
      } else if (data?.type === 'reg_of_day' && data.pcgSlug) {
        router.push(`/pcg/${data.pcgSlug}` as any)
      } else if (data?.type === 'word_of_day' && data.slug) {
        router.push(`/dictionary/${data.slug}` as any)
      } else if (data?.type === 'duel' && data.challengeId) {
        // router.push, not navigate, used to leave a SECOND `/challenges/[id]`
        // instance stacked on top of one already open -- a duel push (invite/
        // accept/completed) can arrive and get tapped while the player is
        // mid-duel on ANY challenge screen, including this exact same one or
        // a different concurrent duel. Two live instances of the same route
        // meant "leave the duel screen, come back" could resolve to a fresh
        // mount showing a DIFFERENT duel's current question under the same
        // "Question N of 5" label -- reported as the duel's question
        // "changing" on return. navigate unwinds to an already-open instance
        // of the SAME duel (preserving its exact in-memory state, including
        // the running timer) instead of stacking a duplicate, and still
        // pushes normally when no matching screen exists yet.
        router.navigate(`/challenges/${data.challengeId}` as any)
      } else if (data?.type === 'collab-invite' && data.token) {
        router.push(`/join/${data.token}` as any)
      } else if (data?.type === 'ac_update') {
        router.push((data.documentNumber ? `/ac/${data.documentNumber}` : '/updates') as any)
      } else if (data?.type === 'ad_alert') {
        router.push((data.userAircraftId ? `/my-aircraft/${data.userAircraftId}` : '/my-aircraft') as any)
      } else if (data?.type === 'reminder' && data.userAircraftId) {
        router.push(`/my-aircraft/${data.userAircraftId}` as any)
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

// Confirmed a real, total gap in the 2026-08-29 crash-resistance sweep: zero
// React error boundaries exist anywhere in this app (grepped the whole
// tree). A synchronous render throw ANYWHERE currently means the whole app
// goes blank with no recovery -- Sentry.wrap() (not used here either) only
// adds breadcrumbs/profiling, it does NOT catch render errors; the actual
// mechanism for that is Sentry.ErrorBoundary, already installed
// (@sentry/react-native re-exports it from @sentry/react) and simply never
// used. Deliberately placed OUTSIDE every provider below -- ThemeProvider
// included -- so a crash inside any one of them still has something above
// it to catch it; the fallback below uses only hardcoded colors/plain RN
// primitives for that same reason (it can't safely assume ANY app context
// is in a working state when it renders).
function RootErrorFallback({ resetError }: { resetError: () => void }) {
  return (
    <View style={fallbackStyles.root}>
      <Text style={fallbackStyles.title}>Something went wrong</Text>
      <Text style={fallbackStyles.body}>
        FlyRegs hit an unexpected error. This has been reported automatically.
      </Text>
      <Pressable style={fallbackStyles.button} onPress={resetError}>
        <Text style={fallbackStyles.buttonText}>Try Again</Text>
      </Pressable>
    </View>
  )
}

function RootLayoutInner() {
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

export default function RootLayout() {
  return (
    <Sentry.ErrorBoundary fallback={RootErrorFallback}>
      <RootLayoutInner />
    </Sentry.ErrorBoundary>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
})

const fallbackStyles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#0A1420', gap: 12 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  body: { color: '#9AA8B8', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  button: { marginTop: 12, backgroundColor: '#2F7DE1', borderRadius: 22, paddingHorizontal: 24, paddingVertical: 12 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
})
