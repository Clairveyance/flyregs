import 'react-native-url-polyfill/auto'
import { AppState, Platform } from 'react-native'
import { createClient } from '@supabase/supabase-js'
import AsyncStorage from '@react-native-async-storage/async-storage'

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})

// Supabase's own documented React Native requirement (autoRefreshToken alone
// isn't enough): a backgrounded RN app has its JS timers suspended, so the
// setInterval-based refresh loop just stops running rather than merely
// slowing down. Without this, a long-backgrounded session's access token can
// go stale past its ~1hr expiry with nothing to refresh it -- REST/RPC calls
// self-heal on the next request (supabase-js refreshes on demand), but an
// already-open Realtime channel's access_token was set once at subscribe
// time and won't reflect a since-expired-then-refreshed session on its own,
// so postgres_changes events can silently stop arriving until the channel is
// torn down and rejoined. Found missing entirely 2026-08-16 while
// investigating why shared-folder Realtime updates ("massive delay",
// sometimes never) -- this was the one piece of Supabase's own official RN
// setup guide this app never had. No-op on web (AppState doesn't apply).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh()
    else supabase.auth.stopAutoRefresh()
  })
}
