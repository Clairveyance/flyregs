import 'react-native-url-polyfill/auto'
import { AppState, Platform } from 'react-native'
import { createClient } from '@supabase/supabase-js'
import AsyncStorage from '@react-native-async-storage/async-storage'

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!

// EVERY failed server call, recorded, in development.
//
// RC, 2026-09-16/17: a 400 went unexplained across three sessions. The reason it
// was so hard to find is worth stating once, here, so nobody loses that time
// again: supabase-js ships its OWN copy of fetch. Patching `window.fetch` at
// runtime -- or XMLHttpRequest, or sendBeacon -- catches nothing it does. The
// only place you can see these is right here, by handing the client the fetch it
// should use.
//
// So it now always has one. In development every non-2xx response is printed
// with its status, the RPC or table it hit, and the server's own message, and
// kept in a small in-memory ring that a QA pass can read back in one go
// (`getRecentApiFailures()`), instead of being reconstructed from console
// scrollback. In production this adds one `if` per request and nothing else --
// reporting there is Sentry's job, not a console's.
export interface ApiFailure {
  at: string
  status: number
  method: string
  /** Just the meaningful part: `rpc/get_folder_collaborators`, `synced_folders`. */
  endpoint: string
  message: string
}

const FAILURE_RING_MAX = 100
const recentFailures: ApiFailure[] = []

/** The last {FAILURE_RING_MAX} failed calls, newest last. Dev/QA only. */
export function getRecentApiFailures(): ApiFailure[] {
  return [...recentFailures]
}

export function clearRecentApiFailures(): void {
  recentFailures.length = 0
}

// Reachable from a browser console during a QA pass on the web preview, where
// there is no other way to read a module-scoped array. Dev only, and web only --
// `globalThis` on a device has nothing useful to attach to.
if (__DEV__ && Platform.OS === 'web') {
  ;(globalThis as any).__apiFailures = getPersistedApiFailures
  ;(globalThis as any).__apiFailuresThisScreen = getRecentApiFailures
  ;(globalThis as any).__clearApiFailures = () => {
    clearRecentApiFailures()
    clearPersistedApiFailures()
  }
}

const PERSIST_KEY = '@flyregs/dev-api-failures'

function persistFailure(f: ApiFailure): void {
  if (Platform.OS !== 'web') return
  try {
    const raw = (globalThis as any).localStorage?.getItem(PERSIST_KEY)
    const all: ApiFailure[] = raw ? JSON.parse(raw) : []
    all.push(f)
    // Same cap as the ring, applied to the persisted list, so a long crawl
    // cannot grow this without bound.
    while (all.length > FAILURE_RING_MAX * 5) all.shift()
    ;(globalThis as any).localStorage?.setItem(PERSIST_KEY, JSON.stringify(all))
  } catch { /* storage unavailable -- the in-memory ring still has it */ }
}

/** Everything recorded across this whole QA session, surviving page loads. */
export function getPersistedApiFailures(): ApiFailure[] {
  try {
    const raw = (globalThis as any).localStorage?.getItem(PERSIST_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function clearPersistedApiFailures(): void {
  try { (globalThis as any).localStorage?.removeItem(PERSIST_KEY) } catch {}
}

function endpointOf(url: string): string {
  const m = url.match(/\/(?:rest\/v1|auth\/v1|functions\/v1|storage\/v1)\/(.+?)(?:\?|$)/)
  return m ? m[1] : url
}

const trackedFetch: typeof fetch = async (input: any, init?: any) => {
  const res = await fetch(input, init)
  // 2xx and 3xx are fine. PostgREST also answers 406 for "no rows" on
  // .single(), which callers handle -- still recorded, because a QA pass should
  // see it and decide, rather than have this file decide for it.
  if (!res.ok && __DEV__) {
    let message = ''
    try {
      const body = await res.clone().text()
      try { message = JSON.parse(body)?.message ?? body } catch { message = body }
    } catch { /* body already consumed or unreadable -- status still tells us */ }
    const failure: ApiFailure = {
      at: new Date().toISOString(),
      status: res.status,
      method: (init && init.method) || 'GET',
      endpoint: endpointOf(String(typeof input === 'string' ? input : input?.url ?? '')),
      message: String(message).slice(0, 300),
    }
    recentFailures.push(failure)
    if (recentFailures.length > FAILURE_RING_MAX) recentFailures.shift()
    console.warn(`[API ${failure.status}] ${failure.method} ${failure.endpoint} — ${failure.message}`)
    // On web, also persist. A QA pass walks the app route by route, and every
    // route change on web is a full page load that would otherwise wipe the
    // in-memory ring -- so without this you can only ever see the failures of
    // the single screen you are standing on, which is how a fault that only
    // appears on one obscure screen stays hidden. Dev + web only; a device
    // keeps the in-memory ring and Sentry.
    persistFailure(failure)
  }
  return res
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  global: { fetch: trackedFetch },
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
