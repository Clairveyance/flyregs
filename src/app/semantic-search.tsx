import { useState, useRef, useCallback } from 'react'
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet, ActivityIndicator, Keyboard, Platform } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { semanticSearch, type SemanticSearchResult } from '@/lib/semanticSearch'
import { routeForCitedItem } from '@/lib/citedItems'
import { REG_TYPE } from '@/lib/regTypes'

// "Ask FlyRegs" (task #114) -- the query-UI half of the semantic search
// infrastructure; see src/lib/semanticSearch.ts's own comment for why this
// is a genuinely separate capability from Home's SmartSearch rather than a
// replacement for it. Plus-gated (same tier line as "Unlimited search
// results" in paywall.tsx) since every real query costs a real, if tiny,
// OpenAI API call -- unlike every other free-tier search in this app.

// null means "no extra identifier beyond the REG_TYPE badge itself" -- for
// P/CG and LOI the real title (rendered separately below) IS the
// identifying info; concatenating the type name again just repeated it
// ("P/CG P/CG", "LOI LOI", confirmed live).
function formatSourceLabel(type: SemanticSearchResult['sourceType'], id: string): string | null {
  switch (type) {
    case 'far': return `§ ${id}`
    case 'aim': return `¶ ${id}`
    case 'ad': return `AD ${id}`
    case 'ac': return `AC ${id}`
    default: return null
  }
}

// LOI titles are raw scraped filenames ("Bacon_2011_Legal_Interpretation")
// -- same cleanup MagicLinkPod.tsx already applies for LOI display titles,
// reused here rather than re-deriving it.
function formatResultTitle(type: SemanticSearchResult['sourceType'], title: string): string {
  if (type === 'loi') return title.replace(/_Legal_Interpretation$/i, '').replace(/_/g, ' ')
  return title
}

const EXAMPLE_PROMPTS = [
  'What happens if I lose radio communication in Class C airspace?',
  'When can a student pilot carry passengers?',
  'How does wake turbulence separation work behind a heavy?',
]

export default function SemanticSearchScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const { hasProAccess } = useAuth()
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [results, setResults] = useState<SemanticSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  // RC, real device: "the phone mic (voice to text) keeps shutting off after
  // each word." First theory (WRONG, corrected 2026-08-06 after RC retested
  // on a real phone and it was still broken): dropping the controlled
  // `value` prop for `defaultValue` -- reasoned that re-pushing identical
  // text on every render was the interruption point. That's a real, harmless
  // improvement (kept below) but NOT the actual cause -- confirmed via
  // facebook/react-native#18890, #20778, #37991: a `multiline` TextInput on
  // iOS breaks Dictation regardless of controlled vs. uncontrolled state; the
  // bug is in RN's own native bridging for `RCTUITextView`, not anything an
  // app's own state management can route around. Still open/unfixed upstream
  // as of this writing. Confirms RC's original instinct exactly ("it's
  // working fine in the other search fields") -- those are all single-line;
  // this is the only multiline search box in the app.
  // Real fix: multiline only on platforms that don't have the bug (Android/
  // web -- no complaint on either, and the web preview can't even exercise
  // real OS dictation to have hidden it there). iOS gets a plain single-line
  // field like Home's SmartSearch -- long questions scroll horizontally
  // instead of wrapping while typing, a real but much smaller tradeoff than
  // a mic that silently drops most of what you say.
  const allowMultiline = Platform.OS !== 'ios'
  // Kept from the first attempt: stop re-pushing text into the field on every
  // keystroke (`defaultValue`, not `value`) -- `onChangeText` still mirrors
  // into `query` state for the send button + runSearch(). The one place that
  // sets text FROM CODE (an example-prompt tap) forces a remount via
  // `resetKey` instead -- tried `ref.current.setNativeProps` first, which
  // crashed on web ("not a function"; RN-web's TextInput ref doesn't expose
  // it) and isn't guaranteed on native either under RN's New Architecture.
  const [resetKey, setResetKey] = useState(0)
  const setQueryText = useCallback((text: string) => {
    setQuery(text)
    setResetKey((k) => k + 1)
  }, [])

  const runSearch = (q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 3) return
    // RC, real device: "when hitting the blue 'send' icon, that should be a
    // cue for the k/b [to] auto hide. then, if user taps the text box again
    // to type, the k/b returns." Dismissing here (not just at the button's
    // own onPress) covers every path that fires a search -- the send
    // button, the keyboard's own return/search key, and tapping an example
    // prompt -- with one change instead of three.
    Keyboard.dismiss()
    const mySeq = ++seq.current
    setSearching(true)
    setError(null)
    setSubmittedQuery(trimmed)
    semanticSearch(trimmed)
      .then((hits) => {
        if (mySeq !== seq.current) return
        setResults(hits)
        setSearching(false)
      })
      .catch((e) => {
        if (mySeq !== seq.current) return
        setError(e?.message ?? 'Search failed. Try again.')
        setSearching(false)
      })
  }

  if (!hasProAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Ask FlyRegs" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="text.bubble.fill" size={fs(32)} color={tokens.grn} />
          <Text style={[styles.upsellTitle, { color: tokens.t1, fontSize: fs(17) }]}>
            Ask FlyRegs a real question
          </Text>
          <Text style={[styles.upsellSub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Type a full question in plain English and get the FAR, AIM, P/CG, AC, AD, or LOI passages
            that actually answer it — not just whatever contains the same keywords.
          </Text>
          <Pressable
            style={[styles.upsellBtn, { backgroundColor: tokens.blu }]}
            onPress={() => router.push('/paywall?tier=pro')}
          >
            <Text style={[styles.upsellBtnText, { fontSize: fs(14.5) }]}>Unlock with Pro</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Ask FlyRegs" onBack={() => router.back()} />
      <TabletContainer>
        <View style={styles.content}>
          <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
            <TextInput
              key={resetKey}
              style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(14.5) }]}
              placeholder="Ask a question about the regs…"
              placeholderTextColor={tokens.t3}
              defaultValue={query}
              onChangeText={setQuery}
              onSubmitEditing={() => runSearch(query)}
              returnKeyType="search"
              multiline={allowMultiline}
            />
            {query.length > 0 && (
              <Pressable
                onPress={() => {
                  setQueryText('')
                  setSubmittedQuery('')
                  setResults([])
                  setError(null)
                }}
                hitSlop={8}
                style={styles.clearBtn}
              >
                <Icon name="xmark.circle" size={fs(17)} color={tokens.t4} />
              </Pressable>
            )}
            <Pressable
              style={[styles.searchBtn, { backgroundColor: query.trim().length >= 3 ? tokens.blu : tokens.bdim }]}
              onPress={() => runSearch(query)}
              disabled={query.trim().length < 3 || searching}
            >
              {searching ? <ActivityIndicator size="small" color="#fff" /> : <Icon name="paperplane.fill" size={fs(15)} color="#fff" />}
            </Pressable>
          </View>

          {submittedQuery.length === 0 && !searching && (
            <View style={styles.examplesWrap}>
              <Text style={[styles.examplesLabel, { color: tokens.t3, fontSize: fs(11) }]}>TRY ASKING</Text>
              {EXAMPLE_PROMPTS.map((p) => (
                <Pressable key={p} style={[styles.exampleRow, { borderColor: tokens.bdr }]} onPress={() => { setQueryText(p); runSearch(p) }}>
                  <Icon name="text.bubble.fill" size={fs(13)} color={tokens.t3} />
                  <Text style={[styles.exampleText, { color: tokens.t2, fontSize: fs(13.5) }]}>{p}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {searching && (
            <View style={styles.center}>
              <ActivityIndicator color={tokens.blu} />
            </View>
          )}

          {!searching && error && (
            <Text style={[styles.errorText, { color: tokens.amb, fontSize: fs(13.5) }]}>{error}</Text>
          )}

          {!searching && !error && submittedQuery.length > 0 && results.length === 0 && (
            <Text style={[styles.emptyText, { color: tokens.t3, fontSize: fs(13.5) }]}>
              No close matches found. Try rephrasing, or use Home's regular search for exact terms.
            </Text>
          )}

          {!searching && results.length > 0 && (
            <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardDismissMode="interactive">
              {results.map((r, i) => {
                const meta = REG_TYPE[r.sourceType]
                return (
                  <Pressable
                    key={`${r.sourceType}-${r.sourceId}-${i}`}
                    style={[styles.resultCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                    onPress={() => router.push(routeForCitedItem(r.sourceType, r.sourceId) as any)}
                  >
                    <View style={styles.resultHeader}>
                      <Icon name={meta.icon} size={fs(13)} color={tokens.blu} />
                      <Text style={[styles.resultBadge, { color: tokens.blu, fontSize: fs(11.5) }]}>
                        {meta.label}{formatSourceLabel(r.sourceType, r.sourceId) ? ` ${formatSourceLabel(r.sourceType, r.sourceId)}` : ''}
                      </Text>
                      <View style={{ flex: 1 }} />
                      <Text style={[styles.resultSimilarity, { color: tokens.t4, fontSize: fs(10.5) }]}>
                        {Math.round(r.similarity * 100)}% match
                      </Text>
                    </View>
                    <Text style={[styles.resultTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={2}>
                      {formatResultTitle(r.sourceType, r.title) || formatSourceLabel(r.sourceType, r.sourceId) || meta.label}
                    </Text>
                    <Text style={[styles.resultSnippet, { color: tokens.t2, fontSize: fs(13) }]} numberOfLines={3}>
                      {r.chunkText}
                    </Text>
                  </Pressable>
                )
              })}
            </ScrollView>
          )}
        </View>
      </TabletContainer>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flex: 1, padding: 16 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40, gap: 10 },

  upsellTitle: { fontWeight: '700', textAlign: 'center', marginTop: 4 },
  upsellSub: { textAlign: 'center', lineHeight: 19, maxWidth: 300 },
  upsellBtn: { borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24, marginTop: 6 },
  upsellBtnText: { color: '#fff', fontWeight: '700', fontSize: 14.5 },

  searchWrap: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    borderRadius: 14, borderWidth: 1, padding: 10, minHeight: 46,
  },
  searchInput: { flex: 1, maxHeight: 120, paddingVertical: 4 },
  clearBtn: { paddingBottom: 6 },
  searchBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  examplesWrap: { marginTop: 20, gap: 8 },
  examplesLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 2 },
  exampleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, padding: 12 },
  exampleText: { flex: 1, lineHeight: 18 },

  errorText: { textAlign: 'center', marginTop: 24, lineHeight: 19 },
  emptyText: { textAlign: 'center', marginTop: 24, lineHeight: 19 },

  resultCard: { borderWidth: 1, borderRadius: 12, padding: 14, marginTop: 12, gap: 6 },
  resultHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  resultBadge: { fontWeight: '700', letterSpacing: 0.3 },
  resultSimilarity: { fontWeight: '600' },
  resultTitle: { fontWeight: '600', lineHeight: 19 },
  resultSnippet: { lineHeight: 18 },
})
