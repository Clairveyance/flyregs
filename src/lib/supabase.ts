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

// Every `supabase.functions.invoke()` call in this app MUST pass a
// `timeout` (FunctionInvokeOptions.timeout, supported natively by
// @supabase/functions-js since this project's pinned 2.108.2). Without one,
// invoke()'s underlying fetch has NO timeout at all and hangs forever on a
// stalled/dropped connection -- no error, no retry button, no spinner with
// a way out, nothing. Confirmed live 2026-08-18 against three call sites
// that had shipped with no timeout: semanticSearch.ts, revenuecat.ts's
// syncEntitlements, and account.tsx's delete-account flow.
//
// On timeout, invoke() aborts its own internally-created AbortController,
// and that rejection always surfaces as a FunctionsFetchError with the
// SAME generic message -- "Failed to send a request to the Edge Function"
// -- as any other network failure (offline, DNS, TLS), so error.message
// alone can't tell a caller "this was specifically a timeout." The raw
// abort rejection is preserved as error.context though (see
// FunctionsClient.invoke()'s `.catch((fetchError) => { throw new
// FunctionsFetchError(fetchError) })`), and since none of this app's
// invoke() call sites pass their own external `signal`, the ONLY thing
// that can ever abort the request is the timeout's own internal
// AbortController -- so error.context?.name === 'AbortError' unambiguously
// means "our timeout fired," not just "some fetch error happened."
export function isEdgeFunctionTimeout(error: any): boolean {
  return error?.name === 'FunctionsFetchError' && error?.context?.name === 'AbortError'
}
