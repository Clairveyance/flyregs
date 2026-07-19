import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = 'flyregs_device_id'

// A random, locally-generated ID persisted in AsyncStorage -- not a real
// hardware identifier (that would need a native module and a new build),
// just enough to rate-limit signup abuse from the same device/install.
// Resets if the app is reinstalled or storage is cleared, which is an
// acceptable weaker guarantee for a deterrent rather than a hard block.
function randomId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
}

export async function getDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(STORAGE_KEY)
  if (existing) return existing
  const id = randomId()
  await AsyncStorage.setItem(STORAGE_KEY, id)
  return id
}
