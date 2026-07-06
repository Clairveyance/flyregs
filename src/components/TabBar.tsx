import React from 'react'
import { View, Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { Icon } from '@/components/Icon'

// SF Symbol names in the same order as <Tabs> screens in _layout.tsx
const TAB_ICONS: Record<string, string> = {
  index: 'house',
  search: 'magnifyingglass',
  saved: 'bookmark',
  recents: 'clock',
  notes: 'square.and.pencil',
}

interface TabBarProps {
  state: any
  navigation: any
  descriptors: any
}

export function TabBar({ state, navigation }: TabBarProps) {
  const { tokens } = useTheme()
  const insets = useSafeAreaInsets()

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
      {state.routes.map((route: { key: string; name: string }, index: number) => {
        const isActive = state.index === index
        const color = isActive ? tokens.blu : tokens.t3

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          })
          if (!event.defaultPrevented) {
            navigation.navigate(route.name)
          }
        }

        return (
          <Pressable
            key={route.key}
            style={styles.tab}
            onPress={onPress}
            hitSlop={4}
          >
            <Icon
              name={TAB_ICONS[route.name] ?? 'questionmark'}
              size={22}
              color={color}
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
