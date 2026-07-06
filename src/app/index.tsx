// Root redirect — expo-router uses (tabs)/index.tsx as the home screen
import { Redirect } from 'expo-router'
export default function Root() {
  return <Redirect href="/(tabs)" />
}
