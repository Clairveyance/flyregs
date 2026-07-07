import { Stack } from 'expo-router'
import { View, StyleSheet, Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { StatusBar } from 'expo-status-bar'
import { useFonts } from 'expo-font'
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter'
import { Montserrat_400Regular } from '@expo-google-fonts/montserrat'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useState } from 'react'
import { ThemeProvider, useTheme } from '@/context/theme'
import { AuthProvider } from '@/context/auth'
import { DrawerProvider } from '@/context/drawer'
import { FontScaleProvider } from '@/context/fontScale'
import { Drawer } from '@/components/Drawer'
import { PersistentTabBar } from '@/components/PersistentTabBar'
import { AnimatedSplash } from '@/components/AnimatedSplash'
import { ShareCardProvider } from '@/components/ShareCardCapture'
import { initSentry } from '@/lib/sentry'

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
        }
  )

  useEffect(() => {
    if (fontsLoaded && Platform.OS !== 'web') {
      SplashScreen.hideAsync()
    }
  }, [fontsLoaded])

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
  return (
    <ThemeProvider>
      <FontScaleProvider>
      <AuthProvider>
        <ShareCardProvider>
        <DrawerProvider>
          <AppShell>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="series/[prefix]" />
              <Stack.Screen name="ac/[id]" />
              <Stack.Screen name="auth" options={{ presentation: 'modal' }} />
              <Stack.Screen name="paywall" options={{ presentation: 'modal' }} />
              <Stack.Screen name="account" />
              <Stack.Screen name="faq" />
              <Stack.Screen name="feedback" />
              <Stack.Screen name="about" />
              <Stack.Screen name="privacy" />
              <Stack.Screen name="terms" />
            </Stack>
          </AppShell>
        </DrawerProvider>
        </ShareCardProvider>
      </AuthProvider>
      </FontScaleProvider>
    </ThemeProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
})
