import { Tabs } from 'expo-router'

export default function TabLayout() {
  return (
    <Tabs
      tabBar={() => null}
      screenOptions={{ headerShown: false }}
    >
      {/* tabBar suppressed above -- the real, visible bottom bar is
          PersistentTabBar.tsx, rendered from the root _layout.tsx so it
          persists across non-tab screens too (AC/FAR/AIM detail pages,
          etc). Order here doesn't need to match anything there; it keys
          off route name, not index. */}
      <Tabs.Screen name="index" />
      <Tabs.Screen name="search" />
      <Tabs.Screen name="saved" />
      <Tabs.Screen name="recents" />
      <Tabs.Screen name="notes" />
    </Tabs>
  )
}
