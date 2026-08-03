import { View, Pressable, StyleSheet } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'

// `search` route/path kept as-is (renaming would mean touching every
// internal link) but its icon changed in the 2026-07-28 IA redesign -- it's
// now the study/social/game hub ("Community"), not a search screen. Search
// itself moved to Home.
const TABS = [
  { name: 'index',   icon: 'house',             path: '/'        },
  { name: 'search',  icon: 'bolt',               path: '/search'  },
  { name: 'saved',   icon: 'bookmark',           path: '/saved'   },
  { name: 'recents', icon: 'clock',              path: '/recents' },
  { name: 'notes',   icon: 'square.and.pencil',  path: '/notes'   },
]

// Every route reached FROM the Community tab that has its own top-level
// path. This list has silently gone stale twice already -- once for
// study/ready-room/challenges/profile/account, once for ref-packets --
// because a route added later never got added here, so the tab bar's
// highlight quietly jumped back to Home while the user was still deep in
// a Community flow. Found live 2026-08-02: /semantic-search (Ask
// FlyRegs, reached directly from the Community hub) had the exact same
// gap, plus two more discovered by auditing every route in src/app/
// against this list rather than waiting for the next bug report:
// /my-aircraft and /manage-subscription, both reached from Account (which
// IS in this list) but neither itself was.
//
// KEEP THIS LIST IN SYNC with every route pushed to from search.tsx,
// account.tsx, or any route already in this list -- if a new one doesn't
// show up here, it will silently render as Home instead of Community.
const COMMUNITY_PREFIXES = [
  '/search',
  '/study',
  '/ready-room',
  '/challenges',
  '/profile',
  '/account',
  '/ref-packets',
  '/semantic-search',
  '/my-aircraft',
  '/manage-subscription',
]

function activeTabForPath(pathname: string): string {
  if (COMMUNITY_PREFIXES.some((p) => pathname.startsWith(p))) return 'search'
  if (pathname.startsWith('/saved'))   return 'saved'
  if (pathname.startsWith('/folder'))  return 'saved'
  if (pathname.startsWith('/recents')) return 'recents'
  if (pathname.startsWith('/notes'))   return 'notes'
  return 'index'
}

export function PersistentTabBar() {
  const { tokens } = useTheme()
  const insets = useSafeAreaInsets()
  const pathname = usePathname()
  const router = useRouter()
  const activeTab = activeTabForPath(pathname)
  const fs = useFS()
  const iconSize = fs(22)
  // Grows with the icon so a large text-size setting doesn't clip it against
  // the bar's edge -- at the default 1x scale this is exactly 44, matching
  // the previous fixed height with no visible change.
  const barHeight = Math.max(44, iconSize + 22)

  return (
    <View
      style={[
        styles.container,
        {
          height: barHeight + insets.bottom,
          paddingBottom: insets.bottom,
          backgroundColor: tokens.bg,
          borderTopColor: tokens.bdr,
        },
      ]}
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab.name
        return (
          <Pressable
            key={tab.name}
            style={[styles.tab, { height: barHeight }]}
            onPress={() => router.navigate(tab.path as never)}
            hitSlop={4}
          >
            <Icon
              name={tab.icon}
              size={iconSize}
              color={isActive ? tokens.blu : tokens.t3}
              weight={isActive ? 'semibold' : 'regular'}
            />
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderTopWidth: 1,
  },
  tab: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
