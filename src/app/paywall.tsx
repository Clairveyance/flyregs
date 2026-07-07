import { useState } from 'react'
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
  Platform,
} from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '@/context/auth'
import { useTheme } from '@/context/theme'
import { Icon } from '@/components/Icon'
import { purchaseSubscription, restorePurchases } from '@/lib/revenuecat'
import { useFS } from '@/context/fontScale'

const WING_ASPECT = 971 / 1071 // flyregs-wing.png width/height

type Plan = 'monthly' | 'annual'
type Tier = 'pro' | 'premium'

// ─── Feature definitions ──────────────────────────────────────────────────────

// NOTE: browsing the library and finding ACs via search are both free, no
// account needed — don't list either here. These bullets are specifically
// what Pro adds on top of that free baseline.
const PRO_FEATURES = [
  { icon: 'doc.text',          label: 'The complete text of every Advisory Circular — not just a preview' },
  { icon: 'magnifyingglass',   label: 'In-document search — find any phrase across 30,000+ pages of AC text' },
  { icon: 'folder.fill',       label: 'Custom folders — organize the AC library the FAA never built' },
  { icon: 'bookmark.fill',     label: 'Bookmarks — save any AC for one-tap access' },
  { icon: 'square.and.pencil', label: 'Personal notes linked directly to your ACs' },
]

// The features that Premium adds on top of Pro
const PREMIUM_ADDITIONS = [
  { icon: 'icloud',               label: 'Cloud backup — your library synced across every device' },
  { icon: 'person.2.fill',        label: 'Shared folders for CFIs, flight schools, and students' },
  { icon: 'arrow.down.circle',    label: 'Download ACs for offline use — no internet required' },
  { icon: 'bell.badge',           label: 'Instant alerts when ACs are published or updated' },
]

// Full Premium feature list shown when upgrading from Free
const PREMIUM_FEATURES = [
  ...PRO_FEATURES,
  ...PREMIUM_ADDITIONS,
]

// ─── Pricing ──────────────────────────────────────────────────────────────────

const PRICING = {
  pro:     { monthly: '$2.99', annual: '$14.99', annualSaving: 'Save 58%' },
  premium: { monthly: '$5.99', annual: '$39.99', annualSaving: 'Save 44%' },
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function PaywallScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro, setIsPro, setIsPremium } = useAuth()
  const insets = useSafeAreaInsets()
  const { tier: paramTier } = useLocalSearchParams<{ tier?: string }>()

  // upgradeMode: Pro users upgrading to Premium
  // premiumOnlyMode: Free user hit a Premium-only gate → skip tier picker, show Premium
  const upgradeMode = isPro
  const premiumOnlyMode = !isPro && paramTier === 'premium'

  const [tier, setTier] = useState<Tier>(upgradeMode || premiumOnlyMode ? 'premium' : 'pro')
  const [plan, setPlan] = useState<Plan>('annual')
  const [loading, setLoading] = useState(false)

  const features = tier === 'pro' ? PRO_FEATURES : (upgradeMode ? PREMIUM_ADDITIONS : PREMIUM_FEATURES)
  const pricing = PRICING[tier]

  const tierLabel = tier === 'pro' ? 'Pro' : 'Premium'
  const ctaLabel = (upgradeMode || premiumOnlyMode)
    ? `Upgrade to Premium`
    : `Get ${tierLabel}`

  // The badge tier always reads "Premium" once the user is locked into a
  // Premium-only or Pro→Premium flow; otherwise it follows whichever tier
  // they currently have selected in the picker.
  const badgeTier: Tier = (upgradeMode || premiumOnlyMode) ? 'premium' : tier

  const handleSubscribe = async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Available on iOS & Android', 'Download the FlyRegs app to subscribe.')
      return
    }
    if (!session) {
      Alert.alert('Sign in first', 'Create a free account to subscribe.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign In', onPress: () => router.replace('/auth') },
      ])
      return
    }
    setLoading(true)
    try {
      const activeTier = (upgradeMode || premiumOnlyMode) ? 'premium' : tier
      const status = await purchaseSubscription(activeTier, plan)
      setIsPro(status.isPro)
      setIsPremium(status.isPremium)
      router.dismiss()
    } catch (err: any) {
      // User cancelled — no alert needed
      if (!err?.message?.includes('cancel') && !err?.userCancelled) {
        Alert.alert('Error', err?.message ?? 'Something went wrong.')
      }
    }
    setLoading(false)
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 16), borderBottomColor: tokens.bdr }]}>
        <Text style={[styles.headerTitle, { color: tokens.t1, fontSize: fs(16) }]}>
          {upgradeMode || premiumOnlyMode ? 'Upgrade to Premium' : 'Upgrade FlyRegs'}
        </Text>
        <Pressable onPress={() => router.dismiss()} hitSlop={8} style={styles.closeBtn}>
          <Icon name="xmark" size={18} color={tokens.t3} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Image
            source={require('@/assets/images/flyregs-wing.png')}
            style={{ width: fs(54), height: fs(54) / WING_ASPECT, marginBottom: 2 }}
            resizeMode="contain"
          />
          <TierBadge tier={badgeTier} tokens={tokens} fs={fs} />
          {premiumOnlyMode ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>This is a Premium feature</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
                Upgrade to Premium to unlock this — plus cloud sync, shared folders, offline downloads, and update alerts.
              </Text>
            </>
          ) : upgradeMode ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>Take FlyRegs further</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
                Add cloud sync, shared folders, unlimited offline, and priority alerts to your Pro subscription.
              </Text>
            </>
          ) : (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>The complete FAA AC reference</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
                Everything a pilot, mechanic, or operator needs — in one place.
              </Text>
            </>
          )}
        </View>

        {/* Tier picker — Free users who didn't arrive from a Premium-only gate */}
        {!upgradeMode && !premiumOnlyMode && (
          <View style={[styles.tierPicker, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
            {(['pro', 'premium'] as Tier[]).map((t) => (
              <Pressable
                key={t}
                style={[styles.tierBtn, tier === t && { backgroundColor: tokens.blu }]}
                onPress={() => setTier(t)}
              >
                <Text style={[styles.tierBtnText, { color: tier === t ? '#fff' : tokens.t3, fontSize: fs(14) }]}>
                  {t === 'pro' ? 'Pro' : 'Premium'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Feature list */}
        <View style={[styles.featureBox, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          {(upgradeMode || premiumOnlyMode) && (
            <View style={[styles.featureHeader, { borderBottomColor: tokens.bdr }]}>
              <Text style={[styles.featureHeaderText, { color: tokens.t3, fontSize: fs(11.5) }]}>
                {upgradeMode ? 'Everything in Pro, plus:' : 'Everything in the app, unlocked:'}
              </Text>
            </View>
          )}
          {features.map((f, i) => (
            <View
              key={f.label}
              style={[
                styles.featureRow,
                i < features.length - 1 && { borderBottomWidth: 1, borderBottomColor: tokens.bdr },
              ]}
            >
              <Icon
                name={f.icon}
                size={17}
                color={tier === 'premium' || upgradeMode || premiumOnlyMode ? tokens.gold : tokens.blu}
              />
              <Text style={[styles.featureText, { color: tokens.t1, fontSize: fs(14) }]}>{f.label}</Text>
            </View>
          ))}
        </View>

        {/* Plan picker */}
        <View style={styles.planHeaderRow}>
          <Text style={[styles.pickLabel, { color: tokens.t3, fontSize: fs(11) }]}>CHOOSE A PLAN</Text>
          <TierBadge tier={badgeTier} tokens={tokens} fs={fs} compact />
        </View>
        <View style={styles.planRow}>
          <PlanCard
            title="Monthly"
            price={pricing.monthly}
            period="/mo"
            badge={null}
            selected={plan === 'monthly'}
            onPress={() => setPlan('monthly')}
            tokens={tokens}
            isPremium={tier === 'premium' || upgradeMode || premiumOnlyMode}
          />
          <PlanCard
            title="Annual"
            price={pricing.annual}
            period="/yr"
            badge={pricing.annualSaving}
            selected={plan === 'annual'}
            onPress={() => setPlan('annual')}
            tokens={tokens}
            isPremium={tier === 'premium' || upgradeMode || premiumOnlyMode}
          />
        </View>

        {/* CTA */}
        <Pressable
          style={[
            styles.cta,
            { backgroundColor: tier === 'premium' || upgradeMode || premiumOnlyMode ? tokens.gold : tokens.blu },
            loading && styles.ctaDisabled,
          ]}
          onPress={handleSubscribe}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={[styles.ctaText, { fontSize: fs(16) }]}>{ctaLabel}</Text>
          )}
        </Pressable>

        {/* Restore */}
        <Pressable style={styles.restoreRow} onPress={async () => {
          try {
            const status = await restorePurchases()
            setIsPro(status.isPro)
            setIsPremium(status.isPremium)
            if (status.isPro || status.isPremium) router.dismiss()
            else Alert.alert('No purchases found', 'No active subscription found for this Apple ID.')
          } catch (err: any) {
            Alert.alert('Error', err?.message ?? 'Could not restore purchases.')
          }
        }}>
          <Text style={[styles.restoreText, { color: tokens.t4, fontSize: fs(13) }]}>Restore Purchases</Text>
        </Pressable>

        <Text style={[styles.legal, { color: tokens.t4, fontSize: fs(11) }]}>
          Subscription renews automatically. Cancel anytime in App Store or Google Play settings.
          Prices shown in USD.
        </Text>
      </ScrollView>
    </View>
  )
}

// ─── Tier Badge ───────────────────────────────────────────────────────────────
// Eye-catching gold/blue pill naming the exact plan on offer — shown once up
// top by the headline and again just above the pricing cards, so it's never
// ambiguous which plan ("Pro" vs "Premium") a user is about to buy.

function TierBadge({
  tier, tokens, fs, compact,
}: {
  tier: Tier
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  compact?: boolean
}) {
  const isPremium = tier === 'premium'
  const accentColor = isPremium ? tokens.gold : tokens.blu
  const bg = isPremium ? tokens.goldlt : tokens.bdim
  const bdr = isPremium ? tokens.goldbdr : tokens.bbdr

  return (
    <View style={[
      styles.tierBadge,
      compact && styles.tierBadgeCompact,
      { backgroundColor: bg, borderColor: bdr },
    ]}>
      <Icon name={isPremium ? 'crown.fill' : 'star.fill'} size={compact ? 11 : 13} color={accentColor} />
      <Text style={[
        styles.tierBadgeText,
        compact && styles.tierBadgeTextCompact,
        { color: accentColor, fontSize: fs(compact ? 11 : 13) },
      ]}>
        {tier === 'pro' ? 'PRO' : 'PREMIUM'}
      </Text>
    </View>
  )
}

// ─── Plan Card ────────────────────────────────────────────────────────────────

function PlanCard({
  title, price, period, badge, selected, onPress, tokens, isPremium,
}: {
  title: string
  price: string
  period: string
  badge: string | null
  selected: boolean
  onPress: () => void
  tokens: ReturnType<typeof useTheme>['tokens']
  isPremium: boolean
}) {
  const accentColor = isPremium ? tokens.gold : tokens.blu
  const fs = useFS()

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.planCard,
        {
          backgroundColor: selected ? (isPremium ? tokens.goldlt : tokens.bdim) : tokens.bg2,
          borderColor: selected ? accentColor : tokens.bdr,
        },
      ]}
    >
      {badge ? (
        <View style={[styles.planBadge, { backgroundColor: accentColor }]}>
          <Text style={[styles.planBadgeText, { fontSize: fs(10.5) }]}>{badge}</Text>
        </View>
      ) : (
        <View style={styles.planBadgePlaceholder} />
      )}
      <Text style={[styles.planTitle, { color: selected ? accentColor : tokens.t2, fontSize: fs(12) }]}>
        {title}
      </Text>
      <Text style={[styles.planPrice, { color: tokens.t1, fontSize: fs(24) }]}>{price}</Text>
      <Text style={[styles.planPeriod, { color: tokens.t3, fontSize: fs(12) }]}>{period}</Text>
    </Pressable>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  headerTitle: { fontWeight: '600', fontSize: 16 },
  closeBtn: { position: 'absolute', right: 16, bottom: 12 },

  content: { padding: 20, gap: 16 },

  hero: { gap: 6, alignItems: 'center', paddingVertical: 4 },
  headline: { fontWeight: '700', fontSize: 20, textAlign: 'center' },
  sub: { fontSize: 14, textAlign: 'center', lineHeight: 20, maxWidth: 300 },

  tierPicker: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: 1,
    padding: 3,
    gap: 2,
  },
  tierBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
  },
  tierBtnText: { fontSize: 14, fontWeight: '700' },

  tierBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  tierBadgeCompact: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tierBadgeText: { fontWeight: '800', letterSpacing: 1 },
  tierBadgeTextCompact: { letterSpacing: 0.7 },

  featureBox: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  featureHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  featureHeaderText: { fontSize: 11.5, fontWeight: '600', letterSpacing: 0.3 },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  featureText: { fontSize: 14, flex: 1 },

  pickLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.7,
    paddingLeft: 2,
  },
  planHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: -4,
  },
  planRow: { flexDirection: 'row', gap: 10 },
  planCard: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1.5,
    padding: 14,
    alignItems: 'center',
    gap: 2,
  },
  planBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 4,
  },
  planBadgeText: { color: '#fff', fontSize: 10.5, fontWeight: '700' },
  planBadgePlaceholder: { height: 22, marginBottom: 4 },
  planTitle: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  planPrice: { fontSize: 24, fontWeight: '800', marginTop: 4 },
  planPeriod: { fontSize: 12 },

  cta: {
    borderRadius: 14,
    height: 54,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  ctaDisabled: { opacity: 0.6 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  restoreRow: { alignItems: 'center', paddingVertical: 4 },
  restoreText: { fontSize: 13 },
  legal: { fontSize: 11, textAlign: 'center', lineHeight: 16 },
})
