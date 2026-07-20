import { useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { Icon } from '@/components/Icon'
import { joinSharedFolder } from '@/lib/sharedFolders'

// Opened via the flyregs://join/<token> deep link a folder owner shares.
// Requires being signed in (a collaborator needs their own account to have
// their own subscription checked against) — if not signed in, sends the
// user to sign in first and comes back here after.
export default function JoinFolder() {
  const { tokens } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const { session, loading } = useAuth()
  const { token } = useLocalSearchParams<{ token: string }>()
  const [state, setState] = useState<'joining' | 'done' | 'error'>('joining')
  const [folderName, setFolderName] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (loading || typeof token !== 'string') return
    if (!session) {
      // Come back here once signed in.
      router.replace({ pathname: '/auth' })
      return
    }
    joinSharedFolder(token)
      .then((result) => {
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
        setErrorMsg(err?.message ?? 'This invite link is invalid or has expired.')
        setState('error')
      })
  }, [token, session, loading])

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top + 40 }]}>
      {state === 'joining' && (
        <>
          <ActivityIndicator size="large" color={tokens.blu} />
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(18) }]}>Joining folder…</Text>
        </>
      )}
      {state === 'done' && (
        <>
          <Icon name="checkmark.seal.fill" size={44} color={tokens.gold} />
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
      {state === 'error' && (
        <>
          <Icon name="xmark.circle" size={44} color={tokens.red} />
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
