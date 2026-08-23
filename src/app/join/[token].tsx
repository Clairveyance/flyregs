import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { Icon } from '@/components/Icon'
import { joinSharedFolder } from '@/lib/sharedFolders'
import { joinSharedAircraft, type JoinedAircraft } from '@/lib/aircraftSharing'

// Opened via the flyregs://join/<token> deep link (or the flyregs.com/join/
// {token} Universal Link, both already whitelisted in app.json) a folder OR
// aircraft owner shares -- one token space, one route. Tries
// joinSharedFolder first; a token that doesn't match any folder falls
// through to joinSharedAircraft rather than needing a second route or a
// second website page. Requires being signed in (a collaborator needs
// their own account to have their own subscription checked against) — if
// not signed in, sends the user to sign in first and comes back here after.
export default function JoinFolder() {
  const { tokens } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const { session, loading, isPremium } = useAuth()
  const { token } = useLocalSearchParams<{ token: string }>()
  const [state, setState] = useState<'joining' | 'done' | 'error' | 'needs_premium'>('joining')
  const [kind, setKind] = useState<'folder' | 'aircraft'>('folder')
  const [folderName, setFolderName] = useState('')
  const [aircraftJoined, setAircraftJoined] = useState<JoinedAircraft | null>(null)
  const [errorMsg, setErrorMsg] = useState('')

  // A successful join must never be attempted twice for the same token.
  // onAuthStateChange fires SIGNED_IN repeatedly for the SAME signed-in user
  // with a brand-new session object each time (confirmed live 2026-08-18 --
  // see my-aircraft/index.tsx's load() and AircraftDowngradeGate for the
  // same root cause), and isPremium can flip false->true a beat later, so
  // this effect genuinely re-runs after it has already succeeded. The
  // second run is harmless for a share-LINK token (join_shared_aircraft's
  // share_code branch upserts) but not for a Callsign invite, which is the
  // path every push-notification invite uses: that branch deliberately
  // raises "This invite has already been accepted", which this screen would
  // then render as a hard error over the success it had just shown.
  // Deliberately latched on SUCCESS, not on first attempt -- a needs_premium
  // result must still be able to retry once entitlements actually land.
  const joinedRef = useRef<string | null>(null)

  useEffect(() => {
    if (loading || typeof token !== 'string') return
    if (joinedRef.current === token) return
    if (!session) {
      // Come back here once signed in.
      router.replace({ pathname: '/auth' })
      return
    }
    joinSharedFolder(token)
      .then((result) => {
        joinedRef.current = token
        setKind('folder')
        setFolderName(result.folder_name)
        setState('done')
        // Lands directly on Shared > With Me, where the folder itself now
        // sits as an item -- not its contents, and not wherever Saved's
        // tab state happened to be left from a previous visit. The button
        // below does the same navigation immediately for anyone who taps
        // through before this fires.
        setTimeout(() => router.replace('/saved?tab=shared&sub=withMe'), 1200)
      })
      .catch((err: any) => {
        // Only a token that matches no folder at all falls through to
        // trying it as an aircraft token. Any other failure (Premium
        // required, already own it) means this WAS a real folder token --
        // showing it as a generic/aircraft error would tell a user who
        // never touched aircraft sharing that "aircraft sharing requires
        // Premium," which is simply wrong for what they're doing.
        if (err?.message !== 'Invalid or expired invite link') {
          setKind('folder')
          if (err?.message === 'Folder sharing requires Premium') {
            setState('needs_premium')
          } else {
            setErrorMsg(err?.message ?? 'This invite link is invalid or has expired.')
            setState('error')
          }
          return
        }
        // Not a folder token -- try aircraft. A real Premium gate, not
        // just copy in the share message: every collaborator needs their
        // own subscription (RC: "anyone who is going to be receiving and
        // viewing Fleet data has to, themselves, have a Prem account"),
        // so this is checked BEFORE spending the join attempt, with a
        // distinct state so "you're not Premium" never gets misread as
        // "this link is broken."
        if (!isPremium) { setKind('aircraft'); setState('needs_premium'); return }
        joinSharedAircraft(token)
          .then((result) => {
            joinedRef.current = token
            setKind('aircraft')
            setAircraftJoined(result)
            setState('done')
            setTimeout(() => router.replace('/my-aircraft'), 1200)
          })
          .catch((err: any) => {
            setErrorMsg(err?.message ?? 'This invite link is invalid or has expired.')
            setState('error')
          })
      })
    // session?.user?.id, not the raw session object -- same fix, same
    // reason as my-aircraft/index.tsx's load(): a repeated SIGNED_IN event
    // for an unchanged user hands back a new object every time, and this
    // effect only ever uses `session` as a truthy signed-in check.
  }, [token, session?.user?.id, loading, isPremium])

  const aircraftLabel = aircraftJoined ? (aircraftJoined.nickname || `${aircraftJoined.make} ${aircraftJoined.model}`) : ''

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
      {state === 'joining' && (
        <>
          <ActivityIndicator size="large" color={tokens.blu} />
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(18) }]}>Opening invite…</Text>
        </>
      )}
      {state === 'needs_premium' && (
        <>
          <Icon name="lock.fill" size={fs(44)} color={tokens.blu} />
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>Premium required</Text>
          <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
            {kind === 'folder'
              ? 'Joining a shared folder requires your own Premium subscription.'
              : 'Viewing or editing a shared aircraft requires your own Premium subscription.'}
          </Text>
          <Pressable style={[styles.btn, { backgroundColor: tokens.blu }]} onPress={() => router.replace('/paywall?tier=premium')}>
            <Text style={[styles.btnText, { fontSize: fs(15.5) }]}>Upgrade to Premium</Text>
          </Pressable>
        </>
      )}
      {state === 'done' && kind === 'folder' && (
        <>
          <Icon name="checkmark.seal.fill" size={fs(44)} color={tokens.gold} />
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>You've joined "{folderName}"</Text>
          <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
            You have view-only access to what's in this folder. You'll still need your own Pro or Premium
            subscription to read full AC text.
          </Text>
          <Pressable
            style={[styles.btn, { backgroundColor: tokens.blu }]}
            onPress={() => router.replace('/saved?tab=shared&sub=withMe')}
          >
            <Text style={[styles.btnText, { fontSize: fs(15.5) }]}>View in With Me</Text>
          </Pressable>
        </>
      )}
      {state === 'done' && kind === 'aircraft' && aircraftJoined && (
        <>
          <Icon name="checkmark.seal.fill" size={fs(44)} color={tokens.gold} />
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(20) }]}>You've joined "{aircraftLabel}"</Text>
          {/* RC: "we need a small note informing of read/write access." Same
              spot folders use for their own access-level sentence -- shown
              once, right when it's actually decided, not a persistent
              banner cluttering the aircraft screen afterward. */}
          <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
            {aircraftJoined.role === 'editor'
              ? "You have edit access to this aircraft's equipment, reminders, and ADs."
              : 'You have view-only access to this aircraft.'}
          </Text>
          <Pressable
            style={[styles.btn, { backgroundColor: tokens.blu }]}
            onPress={() => router.replace('/my-aircraft')}
          >
            <Text style={[styles.btnText, { fontSize: fs(15.5) }]}>View in My Fleet</Text>
          </Pressable>
        </>
      )}
      {state === 'error' && (
        <>
          <Icon name="xmark.circle" size={fs(44)} color={tokens.red} />
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(18) }]}>Couldn't join</Text>
          <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>{errorMsg}</Text>
          <Pressable style={[styles.btn, { backgroundColor: tokens.blu }]} onPress={() => router.replace('/')}>
            <Text style={[styles.btnText, { fontSize: fs(15.5) }]}>Back to FlyRegs</Text>
          </Pressable>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', paddingHorizontal: 32, gap: 12 },
  title: { fontWeight: '700', textAlign: 'center', marginTop: 8 },
  sub: { textAlign: 'center', lineHeight: 20, maxWidth: 320 },
  btn: { marginTop: 16, paddingVertical: 14, paddingHorizontal: 28, borderRadius: 14 },
  btnText: { color: '#fff', fontWeight: '700' },
})
