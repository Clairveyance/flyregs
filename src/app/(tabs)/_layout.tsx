import { Tabs } from 'expo-router'

export default function TabLayout() {
  return (
    <Tabs
      tabBar={() => null}
      screenOptions={{ headerShown: false }}
    >
      {/* Order here must match TAB_SYMBOLS index in TabBar.tsx */}
      <Tabs.Screen name="index" />
      <Tabs.Screen name="search" />
      <Tabs.Screen name="saved" />
      <Tabs.Screen name="recents" />
      <Tabs.Screen name="notes" />
    </Tabs>
  )
}
