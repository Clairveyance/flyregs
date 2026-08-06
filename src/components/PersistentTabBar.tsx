import { View, Text, Pressable, StyleSheet } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useDrawer } from '@/context/drawer'
import { useIsTablet } from '@/context/responsive'
import { requestFocusSearch, focusHomeSearchNow } from '@/lib/focusSearchSignal'
import { useScreenActionsContext, ScreenAction } from '@/context/screenActions'
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
  const isTablet = useIsTablet()
  const { open: openDrawer } = useDrawer()
  const { actions: screenActions } = useScreenActionsContext()

  const focusSearch = () => {
    // Try the direct, synchronous path first (see focusSearchSignal.ts) --
    // only fall back to the flag+navigate dance if Home genuinely hasn't
    // registered yet.
    if (!focusHomeSearchNow()) requestFocusSearch()
    router.navigate('/' as never)
  }

  // Phone only: unchanged -- every tab flex:1, spread edge to edge across
  // whatever width the device has. Any iPad, portrait or landscape: RC,
  // real iPad-width screenshot, annotated -- "the bottom menu... we don't
  // need the oval pill border around them. maybe just the small vert lines
  // dividing the sections. keep it clean." A centered, thumb-reachable
  // cluster instead of five icons stretched to the physical edges, with
  // the drawer/menu and a global search-focus shortcut folded into the
  // same bar. RC, separately, on portrait specifically: "the menu bar
  // should still be more capable, we can keep most thing still in it from
  // landscape" -- so this is deliberately gated on isTablet (either
  // orientation), not isTabletLandscape.
  if (isTablet) {
    return (
      <View
        style={[
          styles.containerLandscape,
          {
            height: barHeight + insets.bottom,
            paddingBottom: insets.bottom,
            backgroundColor: tokens.bg,
            borderTopColor: tokens.bdr,
          },
        ]}
      >
        <View style={styles.clusterRow}>
          <Pressable style={[styles.tabFixed, { height: barHeight }]} onPress={openDrawer} hitSlop={4}>
            <Icon name="line.3.horizontal" size={iconSize} color={tokens.t3} />
          </Pressable>
          <View style={[styles.divider, { backgroundColor: tokens.bdr2 }]} />
          {TABS.map((tab) => {
            const isActive = activeTab === tab.name
            return (
              <Pressable
                key={tab.name}
                style={[styles.tabFixed, { height: barHeight }]}
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
          <View style={[styles.divider, { backgroundColor: tokens.bdr2 }]} />
          <Pressable style={[styles.tabFixed, { height: barHeight }]} onPress={focusSearch} hitSlop={4}>
            <Icon name="magnifyingglass" size={iconSize} color={tokens.t3} />
          </Pressable>
          {/* Whatever the current screen registered via useScreenActions
              (bookmark/folder/share, Cancel, filter, Select/+New,
              Back/Delete/Done, ...) -- RC, five annotated iPad screenshots:
              "all things like this need to find their way to the bottom
              of the screen." Empty on any screen that hasn't registered
              anything, so this cluster just doesn't render at all there. */}
          {screenActions.length > 0 && (
            <>
              <View style={[styles.divider, { backgroundColor: tokens.bdr2 }]} />
              {screenActions.map((action) => (
                <ScreenActionButton key={action.key} action={action} barHeight={barHeight} iconSize={iconSize} fs={fs} tokens={tokens} />
              ))}
            </>
          )}
        </View>
      </View>
    )
  }

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

function ScreenActionButton({
  action,
  barHeight,
  iconSize,
  fs,
  tokens,
}: {
  action: ScreenAction
  barHeight: number
  iconSize: number
  fs: (n: number) => number
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const color =
    action.variant === 'destructive' ? tokens.red : action.variant === 'primary' ? tokens.blu : tokens.t3

  if (action.variant === 'primary' && action.label) {
    return (
      <Pressable
        onPress={action.onPress}
        disabled={action.disabled}
        hitSlop={4}
        style={[styles.primaryBtn, { height: barHeight - 16, backgroundColor: tokens.blu, opacity: action.disabled ? 0.5 : 1 }]}
      >
        <Text style={{ color: '#fff', fontWeight: '600', fontSize: fs(13) }}>{action.label}</Text>
      </Pressable>
    )
  }
  if (action.label) {
    return (
      <Pressable onPress={action.onPress} disabled={action.disabled} hitSlop={4} style={{ opacity: action.disabled ? 0.5 : 1 }}>
        <Text style={{ color, fontWeight: '600', fontSize: fs(13) }}>{action.label}</Text>
      </Pressable>
    )
  }
  return (
    <Pressable
      style={[styles.tabFixed, { height: barHeight, opacity: action.disabled ? 0.5 : 1 }]}
      onPress={action.onPress}
      disabled={action.disabled}
      hitSlop={4}
    >
      <Icon name={action.icon!} size={iconSize} color={color} />
    </Pressable>
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
  containerLandscape: {
    borderTopWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clusterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 22,
  },
  tabFixed: {
    width: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    width: 1,
    height: 22,
  },
  primaryBtn: {
    borderRadius: 8,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
