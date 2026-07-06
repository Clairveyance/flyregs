import { View, Text, Image, Pressable, ScrollView, StyleSheet, Linking } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme, ThemeTokens } from '@/context/theme'
import { useReturnToMenu } from '@/context/drawer'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { useFS } from '@/context/fontScale'
import { WORDMARK_FONT, wordmarkGoldFor } from '@/lib/brand'
import {
  APP_NAME,
  COMPANY,
  APP_VERSION,
  BUILD_NUMBER,
  WEBSITE_URL,
  SUPPORT_EMAIL,
} from '@/lib/appInfo'

export default function AboutScreen() {
  const { tokens, resolved } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const backToMenu = useReturnToMenu()

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="About" onBack={backToMenu} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}>
        {/* App identity */}
        <View style={styles.hero}>
          <Image
            source={require('@/assets/images/icon.png')}
            style={[styles.logo, { borderColor: tokens.bdr2 }]}
          />
          <Text style={[styles.appName, { color: wordmarkGoldFor(resolved), fontSize: fs(24), fontFamily: WORDMARK_FONT }]}>{APP_NAME}</Text>
          <Text style={[styles.tagline, { color: tokens.t3, fontSize: fs(13.5) }]}>
            The complete FAA Advisory Circular reference
          </Text>
          <Text style={[styles.version, { color: tokens.t4, fontSize: fs(12) }]}>
            Version {APP_VERSION} ({BUILD_NUMBER})
          </Text>
        </View>

        {/* Description */}
        <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14) }]}>
            {APP_NAME} puts every active FAA Advisory Circular in your pocket — searchable,
            browsable by series, and linkable from your own notes. Built for pilots, mechanics, and
            operators who need the current guidance fast.
          </Text>
        </View>

        {/* Links */}
        <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <LinkRow
            icon="globe"
            label="Website"
            tokens={tokens}
            onPress={() => Linking.openURL(WEBSITE_URL)}
          />
          <LinkRow
            icon="at"
            label="Contact"
            tokens={tokens}
            onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
            last
          />
        </View>

        {/* Attribution */}
        <Text style={[styles.attribution, { color: tokens.t4, fontSize: fs(11.5) }]}>
          Advisory Circular content is published by the U.S. Federal Aviation Administration and is
          in the public domain. {APP_NAME} is an independent product and is not affiliated with or
          endorsed by the FAA.
        </Text>

        <Text style={[styles.copyright, { color: tokens.t4, fontSize: fs(11.5) }]}>
          © {new Date().getFullYear()} {COMPANY}. All rights reserved.
        </Text>
      </ScrollView>
    </View>
  )
}

function LinkRow({
  icon,
  label,
  tokens,
  onPress,
  last,
}: {
  icon: string
  label: string
  tokens: ThemeTokens
  onPress: () => void
  last?: boolean
}) {
  const fs = useFS()
  return (
    <Pressable
      style={[styles.linkRow, !last && { borderBottomWidth: 1, borderBottomColor: tokens.bdr }]}
      onPress={onPress}
    >
      <Icon name={icon} size={17} color={tokens.t2} />
      <Text style={[styles.linkLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>{label}</Text>
      <Icon name="arrow.up.right.square" size={15} color={tokens.t4} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 20, gap: 16 },
  hero: { alignItems: 'center', gap: 6, paddingVertical: 12 },
  logo: {
    width: 76,
    height: 76,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 6,
  },
  appName: { fontSize: 24, letterSpacing: -0.3 },
  tagline: { fontSize: 13.5, textAlign: 'center', maxWidth: 260, lineHeight: 19 },
  version: { fontSize: 12, marginTop: 4 },
  card: { borderRadius: 14, borderWidth: 1, padding: 16 },
  body: { fontSize: 14, lineHeight: 22 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    marginHorizontal: -16,
    paddingHorizontal: 16,
  },
  linkLabel: { flex: 1, fontSize: 14.5, fontWeight: '500' },
  attribution: { fontSize: 11.5, lineHeight: 17, textAlign: 'center' },
  copyright: { fontSize: 11.5, textAlign: 'center' },
})
