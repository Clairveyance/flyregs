import { useEffect } from 'react'
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring, withTiming, withSequence } from 'react-native-reanimated'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { CoinMedal } from '@/components/CoinMedal'
import type { CoinDef } from '@/lib/coins'

// Earning a coin previously fired a plain Alert.alert -- the same OS dialog
// used for every other confirm/error in the app, so a real achievement
// (some of these take weeks of daily study or 25 Duel wins) looked exactly
// like a permission prompt. This is a proper reveal moment: the medal
// scales/rotates in with a spring instead of just appearing, matching how
// CoinMedal's own tier escalation (bevel ring + glow, see that file) reads
// as "more ornate = harder-won" -- the reveal now does too.
export function CoinRevealModal({ coin, onClose }: { coin: CoinDef | null; onClose: () => void }) {
  const { tokens, redShift } = useTheme()
  const fs = useFS()
  const scale = useSharedValue(0.3)
  const rotate = useSharedValue(-25)
  const opacity = useSharedValue(0)

  useEffect(() => {
    if (!coin) return
    scale.value = 0.3
    rotate.value = -25
    opacity.value = 0
    opacity.value = withTiming(1, { duration: 200 })
    scale.value = withSequence(
      withSpring(1.12, { damping: 8, stiffness: 140 }),
      withSpring(1, { damping: 10, stiffness: 180 })
    )
    rotate.value = withSpring(0, { damping: 9, stiffness: 120 })
  }, [coin])

  const medalStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }, { rotate: `${rotate.value}deg` }],
  }))

  if (!coin) return null

  return (
    <Modal visible={!!coin} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Reanimated.View style={medalStyle}>
          <CoinMedal tier={coin.tier} icon={coin.icon} earned size={96} />
        </Reanimated.View>
        <Text style={[styles.eyebrow, { color: tokens.gold, fontSize: fs(11.5) }]}>COIN EARNED</Text>
        <Text style={[styles.name, { color: '#fff', fontSize: fs(21) }]}>{coin.name}</Text>
        <Text style={[styles.desc, { color: redShift ? '#D6553A' : 'rgba(255,255,255,0.7)', fontSize: fs(14), lineHeight: fs(14) * 1.43 }]}>{coin.description}</Text>
        <Pressable style={[styles.btn, { backgroundColor: tokens.gold }]} onPress={onClose}>
          <Text style={[styles.btnText, { fontSize: fs(15) }]}>Nice!</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 6,
  },
  eyebrow: { fontWeight: '800', letterSpacing: 1.5, marginTop: 22 },
  name: { fontWeight: '800', marginTop: 4 },
  // lineHeight NOT set here -- always overridden inline with fs(14) * 1.43
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  desc: { textAlign: 'center', maxWidth: 280, marginTop: 6 },
  btn: { borderRadius: 22, paddingHorizontal: 30, paddingVertical: 12, marginTop: 22 },
  btnText: { color: '#000', fontWeight: '800', fontSize: 15 },
})
