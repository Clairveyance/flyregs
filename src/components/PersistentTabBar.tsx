import { View, Pressable, StyleSheet } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { Icon } from '@/components/Icon'

const TABS = [
  { name: 'index',   icon: 'house',             path: '/'        },
  { name: 'search',  icon: 'magnifyingglass',    path: '/search'  },
  { name: 'saved',   icon: 'bookmark',           path: '/saved'   },
  { name: 'recents', icon: 'clock',              path: '/recents' },
  { name: 'notes',   icon: 'square.and.pencil',  path: '/notes'   },
]

function activeTabForPath(pathname: string): string {
  if (pathname.startsWith('/search'))  return 'search'
  if (pathname.startsWith('/saved'))   return 'saved'
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

  return (
    <View
      style={[
        styles.container,
        {
          height: 44 + insets.bottom,
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
            style={styles.tab}
            onPress={() => router.navigate(tab.path as never)}
            hitSlop={4}
          >
            <Icon
              name={tab.icon}
              size={22}
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
