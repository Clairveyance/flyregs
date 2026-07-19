import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = '@flyregs/just_confirmed'

// Set right after a fresh signup confirmation auto-signs someone in (see
// src/app/confirm.tsx), read once by the Home screen to show a one-time
// welcome banner, then cleared -- a plain query param would get lost across
// the router.replace('/') hop, so this is a simple one-shot flag instead.
export async function markJustConfirmed(): Promise<void> {
  await AsyncStorage.setItem(KEY, '1')
}

export async function consumeJustConfirmed(): Promise<boolean> {
  const value = await AsyncStorage.getItem(KEY)
  if (value) await AsyncStorage.removeItem(KEY)
  return !!value
}
