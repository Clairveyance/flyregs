import { useEffect, useMemo, useState, useCallback } from 'react'
import { View, Text, SectionList, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native'
import { router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { REG_TYPE } from '@/lib/regTypes'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { getWhatsNewItems, routeForWhatsNewItem, WhatsNewItem } from '@/lib/whatsNew'
import {
  getRevisions,
  routeForRevision,
  labelForDocType,
  splitParagraphs,
  ContentRevision,
} from '@/lib/whatsChanged'
import { stripAdSubjectPrefix } from '@/lib/titleFormat'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// RC: "WN is a list of all things new w/n the set duration time. WC is
// everything diff INSIDE an actual doc. Those need to be separated and
// shown apart from just things that are new... WC needs to be a separate
// thing inside there that ONLY shows actual changes that users can go
// directly to and look at." Was `whats-changed.tsx`, reached via Home's
// What's New "All" link -- but that link led straight to real text diffs,
// a completely different concept than "everything new," with no way to
// see a fuller New list at all. Renamed/rebuilt as a single screen with
// two clearly separate tabs so both are one tap away from the same entry
// point, instead of "All" silently meaning "Changed."
type Tab = 'new' | 'changed'

// RC, real device, looking at a genuine list-insertion revision (FAR 119.1
// gained a new item (12), which mechanically shifted (10)/(11)'s trailing
// "or"/"." per normal list-punctuation rules): "what you show as green/red
// is the same thing. like 'this is old, but the same thing is new' - how
// does that work?" Correct, confusing UX -- showing two 95%-identical
// paragraphs as two full separate blocks makes a one-word connector shift
// look exactly as loud as a brand-new provision. Pairs up a removed/added
// paragraph that are mostly the same text and renders ONE line with just
// the differing words highlighted inline, instead of two duplicate-looking
// blocks -- genuinely new content (no real counterpart) still gets its own
// full block.
interface WordToken { type: 'same' | 'add' | 'del'; text: string }

// Plain word-level LCS diff. Kept as the fallback patienceWordDiff below
// calls when a gap between two anchors has no unique word to anchor on
// (small gaps only, by construction -- see patienceWordDiff's own comment).
function lcsWordDiff(a: string[], b: string[]): WordToken[] {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const ops: WordToken[] = []
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { ops.unshift({ type: 'same', text: a[i - 1] }); i--; j-- }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { ops.unshift({ type: 'del', text: a[i - 1] }); i-- }
    else { ops.unshift({ type: 'add', text: b[j - 1] }); j-- }
  }
  while (i > 0) { ops.unshift({ type: 'del', text: a[i - 1] }); i-- }
  while (j > 0) { ops.unshift({ type: 'add', text: b[j - 1] }); j-- }
  return ops
}

// Standard patience-sort longest-increasing-subsequence on bIdx, given
// candidates already sorted by aIdx. O(n log n). Returns the actual
// subsequence (not just its length) via a parent-pointer walk-back.
function longestIncreasingByB<T extends { bIdx: number }>(candidates: T[]): T[] {
  if (candidates.length === 0) return []
  const piles: number[] = []
  const prev: number[] = new Array(candidates.length).fill(-1)
  for (let idx = 0; idx < candidates.length; idx++) {
    const b = candidates[idx].bIdx
    let lo = 0, hi = piles.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (candidates[piles[mid]].bIdx < b) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[idx] = piles[lo - 1]
    if (lo === piles.length) piles.push(idx)
    else piles[lo] = idx
  }
  const seq: T[] = []
  let k = piles[piles.length - 1]
  while (k !== -1) { seq.unshift(candidates[k]); k = prev[k] }
  return seq
}

// RC, real device, on a real FAR 91.313(e) revision: reconstructed what
// the rendered diff actually reads as if you skip every red word --
// "...or unless otherwise authorized operating limitations by the
// Administrator in operating limitations, no person may..." -- and
// correctly called it out: "this sentence doesn't make too much sense
// like this." Root cause, confirmed against the REAL added/removed text
// pulled from content_revisions (not a guess): plain word-level LCS
// maximizes the total COUNT of matched words with no understanding of
// clause boundaries, so when a short, common phrase happens to appear
// once in the OLD-only clause and once in the unrelated NEW-only clause
// (here: "operating limitations" -- once in "special operating
// limitations issued," once in "in operating limitations,", two
// completely different clauses that coincidentally share those two
// words), plain LCS greedily matches them as "unchanged" and produces a
// cross-eyed alignment no human would construct. This is a well-known
// failure mode of plain LCS diffing on real prose -- it's exactly why
// tools like git offer "patience diff" as an alternative to the default
// Myers/LCS algorithm. Implements that same idea: anchor on words that
// appear EXACTLY ONCE on both sides (so a coincidental short common
// phrase can't hijack the alignment the way a repeated one can), take the
// longest run of those anchors that stays in-order on both sides, then
// recursively diff only the small gaps BETWEEN anchors (falling back to
// plain lcsWordDiff there, where a repeated-word ambiguity is much less
// likely in a short gap). Verified against the real 91.313(e) text: this
// produces "unless otherwise authorized" (all green) cleanly replacing
// "special operating limitations issued" (all red) as one block, and
// "Administrator in operating limitations," (all green) sitting directly
// before "Administrator," (red) as another -- exactly RC's own described
// ideal ("if a green addition is on either side of a red removal, the red
// word can stay in the middle, and the reader omits it"). Always
// reconstructs the real old text from same+del tokens and the real new
// text from same+add tokens exactly, the same guarantee plain LCS gives.
function patienceWordDiff(a: string[], b: string[]): WordToken[] {
  if (a.length === 0) return b.map((w) => ({ type: 'add', text: w }))
  if (b.length === 0) return a.map((w) => ({ type: 'del', text: w }))

  const positionsInA = new Map<string, number[]>()
  a.forEach((w, i) => { const arr = positionsInA.get(w) ?? []; arr.push(i); positionsInA.set(w, arr) })
  const positionsInB = new Map<string, number[]>()
  b.forEach((w, i) => { const arr = positionsInB.get(w) ?? []; arr.push(i); positionsInB.set(w, arr) })

  const candidates: { aIdx: number; bIdx: number }[] = []
  positionsInA.forEach((aPositions, word) => {
    if (aPositions.length !== 1) return
    const bPositions = positionsInB.get(word)
    if (bPositions && bPositions.length === 1) candidates.push({ aIdx: aPositions[0], bIdx: bPositions[0] })
  })
  candidates.sort((x, y) => x.aIdx - y.aIdx)

  const anchors = longestIncreasingByB(candidates)
  if (anchors.length === 0) return lcsWordDiff(a, b)

  const result: WordToken[] = []
  let prevA = 0, prevB = 0
  for (const anchor of anchors) {
    result.push(...patienceWordDiff(a.slice(prevA, anchor.aIdx), b.slice(prevB, anchor.bIdx)))
    result.push({ type: 'same', text: a[anchor.aIdx] })
    prevA = anchor.aIdx + 1
    prevB = anchor.bIdx + 1
  }
  result.push(...patienceWordDiff(a.slice(prevA), b.slice(prevB)))
  return result
}

function paragraphSimilarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))
  if (wa.size === 0 || wb.size === 0) return 0
  let shared = 0
  wa.forEach((w) => { if (wb.has(w)) shared++ })
  return shared / Math.max(wa.size, wb.size)
}

type DiffGroup =
  | { kind: 'pair'; removed: string; added: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }

// Greedy nearest-match pairing -- >=55% shared words is "the same
// paragraph, reworded/reflowed," anything below that is treated as
// genuinely unrelated content, matching the module-level noise threshold
// sync/revision_log.py's own _normalize_for_diff() already uses as its
// bar for "not worth flagging."
const PAIR_SIMILARITY_THRESHOLD = 0.55

function groupDiff(removed: string[], added: string[]): DiffGroup[] {
  const usedAdded = new Set<number>()
  const pairs: { ri: number; ai: number; score: number }[] = []
  removed.forEach((r, ri) => {
    let best = -1, bestScore = 0
    added.forEach((a, ai) => {
      if (usedAdded.has(ai)) return
      const score = paragraphSimilarity(r, a)
      if (score > bestScore) { bestScore = score; best = ai }
    })
    if (best >= 0 && bestScore >= PAIR_SIMILARITY_THRESHOLD) {
      pairs.push({ ri, ai: best, score: bestScore })
      usedAdded.add(best)
    }
  })
  const pairedRemoved = new Set(pairs.map((p) => p.ri))
  const out: DiffGroup[] = []
  removed.forEach((r, ri) => {
    const pair = pairs.find((p) => p.ri === ri)
    if (pair) out.push({ kind: 'pair', removed: r, added: added[pair.ai] })
    else if (!pairedRemoved.has(ri)) out.push({ kind: 'del', text: r })
  })
  added.forEach((a, ai) => {
    if (!usedAdded.has(ai)) out.push({ kind: 'add', text: a })
  })
  return out
}

export default function UpdatesScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess, loading: authLoading } = useAuth()
  const { badgeDays } = useBadgeLifespan()
  const [tab, setTab] = useState<Tab>('new')

  // hasPlusAccess reads false for everyone until auth's `loading` resolves
  // (cold launch / post-Face-ID -- see context/auth.tsx), so a real Plus
  // subscriber deep-linked or tapped in here inside that window saw
  // "Updates is a Plus feature" before their own content appeared.
  if (!hasPlusAccess && authLoading) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Updates" onBack={() => router.back()} />
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      </View>
    )
  }

  if (!hasPlusAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Updates" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Updates is a Plus feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            See every new document, and a real, browsable diff of exactly what changed in existing ones.
          </Text>
          <Pressable style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall?tier=plus')}>
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Updates" onBack={() => router.back()} />
      <View style={[styles.segWrap, { backgroundColor: tokens.bg3 }]}>
        <Pressable style={[styles.segBtn, tab === 'new' && { backgroundColor: tokens.bg2 }]} onPress={() => setTab('new')}>
          <Text style={[styles.segLabel, { color: tab === 'new' ? tokens.t1 : tokens.t2, fontSize: fs(13) }]}>New</Text>
        </Pressable>
        <Pressable style={[styles.segBtn, tab === 'changed' && { backgroundColor: tokens.bg2 }]} onPress={() => setTab('changed')}>
          <Text style={[styles.segLabel, { color: tab === 'changed' ? tokens.t1 : tokens.t2, fontSize: fs(13) }]}>Changed</Text>
        </Pressable>
      </View>
      {tab === 'new' ? <NewTab badgeDays={badgeDays} /> : <ChangedTab badgeDays={badgeDays} />}
    </View>
  )
}

// ─── Type filter chips ──────────────────────────────────────────────────────

// RC, annotated screenshot: "up in this area, it might be good to have
// small selector buttons for AC, AD, FAR, etc so users can sort quickly
// through a long list." Round 2, RC: "AC and AD are most common and
// usually longest lists, there are a few others sometimes, FARs, etc, so
// let's make those others separately sortable. So, chips are All, AC, AD,
// Other" -- a fixed 3-bucket model (everything that isn't AC/AD groups
// into "Other") instead of one chip per raw type, shared between both
// tabs.
type ChipFilter = 'ac' | 'ad' | 'other'
const CHIP_LABELS: Record<ChipFilter, string> = { ac: 'AC', ad: 'AD', other: 'Other' }
const CHIP_ORDER: ChipFilter[] = ['ac', 'ad', 'other']

function TypeFilterChips({
  active,
  counts,
  onChange,
  tokens,
  fs,
}: {
  active: ChipFilter | null
  counts: Record<ChipFilter, number>
  onChange: (t: ChipFilter | null) => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
}) {
  // RC, real device: first fixed to hide the whole chip row only when
  // truly nothing existed anywhere (was hiding a fully-populated "Other"
  // chip whenever AC/AD both happened to be 0). RC's own follow-up
  // clarified further: "all four need to be on both pages. they all need
  // to visible all the time, even w/o current contents. empty ones can
  // display a 0." No visibility logic left at all now -- always render
  // every chip, count included.
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll} contentContainerStyle={styles.filterRow}>
      <Pressable
        style={[
          styles.filterChip,
          { backgroundColor: tokens.bdim, borderColor: tokens.bbdr },
          active === null && { backgroundColor: tokens.blu, borderColor: tokens.blu },
        ]}
        onPress={() => onChange(null)}
      >
        <Text numberOfLines={1} style={[styles.filterChipText, { color: active === null ? '#fff' : tokens.blu, fontSize: fs(12) }]}>All</Text>
      </Pressable>
      {CHIP_ORDER.map((t) => (
        <Pressable
          key={t}
          style={[
            styles.filterChip,
            { backgroundColor: tokens.bdim, borderColor: tokens.bbdr },
            active === t && { backgroundColor: tokens.blu, borderColor: tokens.blu },
          ]}
          onPress={() => onChange(active === t ? null : t)}
        >
          <Text numberOfLines={1} style={[styles.filterChipText, { color: active === t ? '#fff' : tokens.blu, fontSize: fs(12) }]}>
            {CHIP_LABELS[t]} · {counts[t]}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  )
}

// ─── New tab ────────────────────────────────────────────────────────────────

// Public, same-for-every-viewer content (document number/title/date
// metadata only, no gated body text -- getWhatsNewItems() already reads
// through advisory_circulars_gated internally) -- no uid-scoping needed,
// matching Home's own HOME_CACHE_KEY convention. This whole screen is
// Plus-gated, but NewTab only ever mounts once UpdatesScreen has already
// confirmed hasPlusAccess is true (see the two early-return branches
// above), so there's no risk of a non-Plus viewer's device ever reading a
// Plus viewer's cache here -- same reasoning as ad/index.tsx's own
// AD_NEWADS_CACHE_KEY.
//
// Only the "New" tab (the default/first-loaded one) is cached -- ChangedTab
// below is left as a direct fetch. Its data (getRevisions(), a real
// paragraph-level text diff) is a meaningfully heavier/rarer-to-revisit
// payload than a simple document list, and wrapping it would also mean
// caching the real-time-expensive diff computation's *inputs* per
// badgeDays window, not a single stable shape -- not worth the added
// complexity for a secondary tab most opens never reach; RC's own framing
// of the bug ("everything in the app... moving around") is squarely about
// the FIRST screen a tap lands on, which for Updates is always New.
const UPDATES_NEW_CACHE_KEY = '@flyregs/updates-new-cache'

function NewTab({ badgeDays }: { badgeDays: number }) {
  const { tokens } = useTheme()
  const fs = useFS()
  const [items, setItems] = useState<WhatsNewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<ChipFilter | null>(null)
  // What's New card titles run long and get cut off the same way FAR Part
  // titles do -- same hook/card pair as far/index.tsx's own long-press
  // preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  const loadItems = useCallback(async () => {
    // Show cached data immediately so this tab doesn't pop in a beat after
    // the query resolves -- same reasoning as Home's own REG_OF_DAY_CACHE_KEY
    // comment.
    let lastGood: WhatsNewItem[] = []
    try {
      const cached = await AsyncStorage.getItem(UPDATES_NEW_CACHE_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as WhatsNewItem[]
        if (parsed?.length) { setItems(parsed); lastGood = parsed }
        setLoading(false)
      }
    } catch (_) {}

    // Then fetch fresh data (existing query, unchanged)
    try {
      const fresh = await getWhatsNewItems(badgeDays)
      setItems(fresh)
      setLoading(false)
      AsyncStorage.setItem(UPDATES_NEW_CACHE_KEY, JSON.stringify(fresh)).catch(() => {})
    } catch (_) {
      // Network failed -- cached data (if any) stays visible
      setLoading(false)
    }
  }, [badgeDays])

  useEffect(() => { loadItems() }, [loadItems])

  const counts = useMemo(() => {
    const c: Record<ChipFilter, number> = { ac: 0, ad: 0, other: 0 }
    for (const item of items) {
      if (item.kind === 'ac') c.ac++
      else if (item.kind === 'ad') c.ad++
      else c.other++
    }
    return c
  }, [items])

  const filtered = useMemo(() => {
    if (!filter) return items
    if (filter === 'other') return items.filter((i) => i.kind !== 'ac' && i.kind !== 'ad')
    return items.filter((i) => i.kind === filter)
  }, [items, filter])

  const sections = useMemo(() => {
    const out: { title: string; data: WhatsNewItem[] }[] = []
    for (const item of filtered) {
      const label = item.date
        ? new Date(item.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : 'Undated'
      let s = out.find((s) => s.title === label)
      if (!s) { s = { title: label, data: [] }; out.push(s) }
      s.data.push(item)
    }
    return out
  }, [filtered])

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={tokens.blu} /></View>
  }
  if (items.length === 0) {
    return (
      <View style={styles.center}>
        <Icon name="sparkles" size={fs(36)} color={tokens.t4} />
        <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Nothing new</Text>
        <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
          Nothing issued or updated in the last {badgeDays} day{badgeDays === 1 ? '' : 's'}. Try a longer Badge Duration in the menu to see more.
        </Text>
      </View>
    )
  }

  return (
    <TabletContainer>
      <TypeFilterChips active={filter} counts={counts} onChange={setFilter} tokens={tokens} fs={fs} />
      {filtered.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No {filter ? CHIP_LABELS[filter] : ''} items</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>Try a different filter above.</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => `${item.kind}-${item.id}`}
          contentContainerStyle={styles.list}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.dateHeader, { color: tokens.t3, fontSize: fs(11) }]}>{section.title.toUpperCase()}</Text>
          )}
          renderItem={({ item }) => (
            <NewRow
              item={item}
              tokens={tokens}
              fs={fs}
              showPreview={showPreview}
              hidePreview={hidePreview}
              consumeLongPress={consumeLongPress}
            />
          )}
        />
      )}
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </TabletContainer>
  )
}

function NewRow({
  item, tokens, fs, showPreview, hidePreview, consumeLongPress,
}: {
  item: WhatsNewItem
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const meta = REG_TYPE[item.kind]
  const badgeKind = item.kind === 'ac' ? getBadgeKind({ document_number: item.documentNumber, cancels: item.cancels, changed_block_indices: item.changedBlockIndices }) : 'new'
  const badge = getBadgeStyle(badgeKind, tokens)
  const title = item.kind === 'ad' ? stripAdSubjectPrefix(item.title) : item.title

  return (
    <Pressable
      style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => {
        if (consumeLongPress()) return
        router.push(routeForWhatsNewItem(item) as any)
      }}
      onLongPress={(e) => showPreview(`${item.documentNumber} — ${title}`, e)}
      onPressOut={hidePreview}
      delayLongPress={350}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.typeChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
          <Icon name={meta.icon} size={fs(10)} color={tokens.blu} />
          <Text style={[styles.typeChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>{meta.label}</Text>
        </View>
        <View style={[styles.durationChip, { backgroundColor: badge.background, borderColor: badge.border }]}>
          <Text style={[styles.durationChipText, { color: badge.color, fontSize: fs(9.5) }]}>{badge.label}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardTitle, { color: tokens.t1, fontSize: fs(14), lineHeight: fs(14) * 1.36 }]} numberOfLines={2}>
            {item.documentNumber}{item.kind === 'ac' && isOcrScanned(item.documentNumber) ? ' *' : ''} — {title}
          </Text>
        </View>
        <Icon name="chevron.right" size={fs(13)} color={tokens.t3} />
      </View>
    </Pressable>
  )
}

// ─── Changed tab ────────────────────────────────────────────────────────────

function ChangedTab({ badgeDays }: { badgeDays: number }) {
  const { tokens, redShift } = useTheme()
  const fs = useFS()
  const [revisions, setRevisions] = useState<ContentRevision[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // getRevisions() now throws on a real fetch error (2026-08-14 QA sweep --
  // it used to swallow `error` silently, which would have rendered this
  // tab's real empty state ("no changes") for a genuine failure too). This
  // catch is what keeps that a real, visible error instead of leaving
  // `loading` stuck true forever -- without it, an unhandled rejection here
  // would never call setLoading(false), the exact infinite-spinner shape
  // just fixed on the Duel/RefPack-task screens.
  const [loadError, setLoadError] = useState(false)
  const [filter, setFilter] = useState<ChipFilter | null>(null)

  useEffect(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - badgeDays)
    setLoading(true)
    setLoadError(false)
    getRevisions(cutoff.toISOString().split('T')[0])
      .then((r) => { setRevisions(r); setLoading(false) })
      .catch(() => { setLoadError(true); setLoading(false) })
  }, [badgeDays])

  const counts = useMemo(() => {
    const c: Record<ChipFilter, number> = { ac: 0, ad: 0, other: 0 }
    for (const r of revisions) {
      if (r.docType === 'ac') c.ac++
      else if (r.docType === 'ad') c.ad++
      else c.other++
    }
    return c
  }, [revisions])

  const filteredRevisions = useMemo(() => {
    if (!filter) return revisions
    if (filter === 'other') return revisions.filter((r) => r.docType !== 'ac' && r.docType !== 'ad')
    return revisions.filter((r) => r.docType === filter)
  }, [revisions, filter])

  const sections = useMemo(() => {
    const out: { title: string; data: ContentRevision[] }[] = []
    for (const r of filteredRevisions) {
      const label = new Date(r.revisedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      let s = out.find((s) => s.title === label)
      if (!s) { s = { title: label, data: [] }; out.push(s) }
      s.data.push(r)
    }
    return out
  }, [filteredRevisions])

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={tokens.blu} /></View>
  }

  if (loadError) {
    return (
      <View style={styles.center}>
        <Icon name="exclamationmark.triangle" size={fs(36)} color={tokens.t4} />
        <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Couldn't load changes</Text>
        <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>Check your connection and try again.</Text>
        <Pressable
          style={[styles.retryBtn, { borderColor: tokens.blu }]}
          onPress={() => {
            setLoading(true)
            setLoadError(false)
            const cutoff = new Date()
            cutoff.setDate(cutoff.getDate() - badgeDays)
            getRevisions(cutoff.toISOString().split('T')[0])
              .then((r) => { setRevisions(r); setLoading(false) })
              .catch(() => { setLoadError(true); setLoading(false) })
          }}
        >
          <Text style={[styles.retryBtnText, { color: tokens.blu, fontSize: fs(14) }]}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <>
      <Text style={[styles.scopeLabel, { color: tokens.t3, fontSize: fs(12) }]}>
        Real paragraph-level changes in the last {badgeDays} day{badgeDays === 1 ? '' : 's'} — not just "this was updated."
      </Text>
      <TypeFilterChips active={filter} counts={counts} onChange={setFilter} tokens={tokens} fs={fs} />
      {revisions.length === 0 ? (
        <View style={styles.center}>
          <Icon name="doc.badge.clock" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No changes in this window</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            Try a longer Badge Duration in the menu to see further back.
          </Text>
        </View>
      ) : filteredRevisions.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No {filter ? CHIP_LABELS[filter] : ''} changes</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>Try a different filter above.</Text>
        </View>
      ) : (
        <TabletContainer>
          <SectionList
            sections={sections}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            renderSectionHeader={({ section }) => (
              <Text style={[styles.dateHeader, { color: tokens.t3, fontSize: fs(11) }]}>{section.title.toUpperCase()}</Text>
            )}
            renderItem={({ item }) => (
              <RevisionRow
                item={item}
                tokens={tokens}
                redShift={redShift}
                fs={fs}
                expanded={expanded === item.id}
                onToggle={() => setExpanded((prev) => (prev === item.id ? null : item.id))}
              />
            )}
          />
        </TabletContainer>
      )}
    </>
  )
}

function RevisionRow({
  item,
  tokens,
  redShift,
  fs,
  expanded,
  onToggle,
}: {
  item: ContentRevision
  tokens: ReturnType<typeof useTheme>['tokens']
  redShift: boolean
  fs: (n: number) => number
  expanded: boolean
  onToggle: () => void
}) {
  const added = splitParagraphs(item.addedText)
  const removed = splitParagraphs(item.removedText)
  const title = item.docType === 'ad' ? stripAdSubjectPrefix(item.title ?? item.docKey) : (item.title ?? item.docKey)
  const groups = useMemo(() => groupDiff(removed, added), [removed, added])

  return (
    <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
      <Pressable style={styles.cardHeader} onPress={onToggle}>
        <View style={[styles.typeChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
          <Text style={[styles.typeChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>{labelForDocType(item.docType)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardTitle, { color: tokens.t1, fontSize: fs(14), lineHeight: fs(14) * 1.36 }]} numberOfLines={expanded ? undefined : 3}>
            {title}
          </Text>
          <Text style={[styles.diffCounts, { color: tokens.t4, fontSize: fs(11.5) }]}>
            {added.length > 0 && `+${added.length}`}{added.length > 0 && removed.length > 0 && ' '}
            {removed.length > 0 && `−${removed.length}`}
            {added.length === 0 && removed.length === 0 && 'Revised'}
          </Text>
        </View>
        <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.t3} />
      </Pressable>

      {expanded && (
        <View style={styles.diffBody}>
          {groups.map((g, i) => {
            if (g.kind === 'add') {
              return (
                <View key={`g${i}`} style={[styles.diffLine, { backgroundColor: tokens.gdim, borderColor: tokens.gbdr }]}>
                  <Text style={[styles.diffMark, { color: tokens.grn, fontSize: fs(13) }]}>+</Text>
                  <Text style={[styles.diffText, { color: tokens.t1, fontSize: fs(13), lineHeight: fs(13) * 1.46 }]}>{g.text}</Text>
                </View>
              )
            }
            if (g.kind === 'del') {
              return (
                <View key={`g${i}`} style={[styles.diffLine, redShift ? { backgroundColor: 'rgba(255,45,18,0.08)', borderColor: 'rgba(255,45,18,0.3)' } : { backgroundColor: 'rgba(220,60,60,0.08)', borderColor: 'rgba(220,60,60,0.3)' }]}>
                  <Text style={[styles.diffMark, { color: tokens.red, fontSize: fs(13) }]}>−</Text>
                  {/* RC: "anything Out is in red, so we don't need to
                      strikethrough on those (it's too hard to read w/ it
                      anyway)" -- red alone already signals removed. */}
                  <Text style={[styles.diffText, { color: tokens.t3, fontSize: fs(13), lineHeight: fs(13) * 1.46 }]}>{g.text}</Text>
                </View>
              )
            }
            // Paired -- mostly the same paragraph, reworded/reflowed (e.g.
            // a list insertion elsewhere shifting this item's trailing "or"
            // to a "."). One line, only the actually-different words
            // highlighted, so a one-word connector shift doesn't read as
            // loudly as genuinely new content. patienceWordDiff (see its
            // own comment above) is what keeps a real substitution reading
            // as one clean red block next to one clean green block instead
            // of a scattered word-by-word interleaving.
            const tokensDiff = patienceWordDiff(g.removed.split(/\s+/).filter(Boolean), g.added.split(/\s+/).filter(Boolean))
            return (
              <View key={`g${i}`} style={[styles.diffLine, { backgroundColor: tokens.bg3, borderColor: tokens.bdr }]}>
                <Icon name="arrow.triangle.2.circlepath" size={fs(12)} color={tokens.t3} />
                <Text style={[styles.diffText, { color: tokens.t1, fontSize: fs(13), lineHeight: fs(13) * 1.46 }]}>
                  {tokensDiff.map((t, ti) => {
                    if (t.type === 'same') return <Text key={ti}>{t.text} </Text>
                    if (t.type === 'add') return <Text key={ti} style={{ color: tokens.grn, fontWeight: '700', backgroundColor: tokens.gdim }}>{t.text} </Text>
                    return <Text key={ti} style={{ color: tokens.red }}>{t.text} </Text>
                  })}
                </Text>
              </View>
            )
          })}
          <Pressable
            style={[styles.openBtn, { borderColor: tokens.bdr }]}
            onPress={() => router.push(routeForRevision(item) as any)}
          >
            <Text style={[styles.openBtnText, { color: tokens.blu, fontSize: fs(13) }]}>Open full document</Text>
            <Icon name="chevron.right" size={fs(12)} color={tokens.blu} />
          </Pressable>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  // lineHeight NOT set here -- always overridden inline with fs(13.5) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  emptySub: { textAlign: 'center', maxWidth: 300 },
  retryBtn: { marginTop: 14, borderWidth: 1, borderRadius: 18, paddingHorizontal: 18, paddingVertical: 9 },
  retryBtnText: { fontWeight: '700' },
  upgradeBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, marginTop: 10 },
  upgradeBtnText: { color: '#fff', fontWeight: '700' },

  segWrap: { flexDirection: 'row', borderRadius: 10, padding: 2, marginHorizontal: 16, marginTop: 12, marginBottom: 4 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segLabel: { fontWeight: '600' },

  scopeLabel: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 2 },

  // RC, real device: chips were "not at all legible or positioned
  // correctly" -- root cause confirmed via DOM inspection, not guessed:
  // a horizontal ScrollView with no explicit `style` (only
  // `contentContainerStyle`) collapses to a ~14px cross-axis height on
  // web when nested inside a flex-column ancestor chain, clipping every
  // chip's padding+text down to an illegible sliver via the ScrollView's
  // own `overflow-y: hidden`. `filterScroll` gives it a real, fixed
  // height so that can't happen regardless of content/font-scale.
  filterScroll: { flexGrow: 0, flexShrink: 0, height: 46 },
  // RC, real device: "center these chips" -- at most 4 short chips (All/AC/
  // AD/Other) rarely fill a phone-width row, and left-aligned inside the
  // ScrollView they read as stranded against the left edge with a dead gap
  // on the right. flexGrow:1 on the content container stretches it to at
  // least the ScrollView's own width whenever content is narrower (the
  // usual case here), which is what lets justifyContent:'center' actually
  // center the row instead of being a no-op -- content container width is
  // otherwise just the intrinsic sum of its children. If the chip set ever
  // grows enough to overflow, this still scrolls correctly; centering only
  // has a visible effect on the non-overflowing case it's meant for.
  filterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8, flexGrow: 1 },
  filterChip: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  filterChipText: { fontWeight: '600' },

  list: { padding: 12, paddingBottom: 32 },
  dateHeader: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, marginTop: 10, paddingLeft: 2 },

  card: { borderRadius: 14, borderWidth: 1, marginBottom: 8, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13 },
  typeChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3 },
  typeChipText: { fontWeight: '700', letterSpacing: 0.3 },
  durationChip: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 3 },
  durationChipText: { fontWeight: '700', letterSpacing: 0.3 },
  // lineHeight NOT set here -- always overridden inline with fs(14) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  cardTitle: { fontWeight: '600' },
  diffCounts: { marginTop: 2, fontWeight: '600' },

  diffBody: { paddingHorizontal: 13, paddingBottom: 13, gap: 6 },
  diffLine: { flexDirection: 'row', gap: 8, borderRadius: 8, borderWidth: 1, padding: 9 },
  diffMark: { fontWeight: '700', width: 12 },
  // lineHeight NOT set here -- always overridden inline with fs(13) * 1.46
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  diffText: { flex: 1 },

  openBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 10, borderWidth: 1, paddingVertical: 10, marginTop: 4,
  },
  openBtnText: { fontWeight: '600' },
})
