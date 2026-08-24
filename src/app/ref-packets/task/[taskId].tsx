import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { TabletContainer } from '@/components/TabletContainer'
import { RegPreviewPane } from '@/components/RegPreviewPane'
import { Icon } from '@/components/Icon'
import { REG_TYPE } from '@/lib/regTypes'
import { getRefPacketTask, RefPacketTask, RefPacketElement } from '@/lib/refPackets'
import { linkifyText } from '@/lib/crossRefLinks'
import { searchRefPackTopic, cleanAcsTaskTitleQuery, RefPackSearchGroup } from '@/lib/refPackSearch'
import { splitIntoDisplayParagraphs } from '@/lib/regTextFormat'
import { highlightSpans } from '@/lib/searchHighlight'

export default function RefPacketTaskScreen() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>()
  const { tokens, redShift } = useTheme()
  const { hasPlusAccess, hasProAccess, loading: authLoading } = useAuth()
  const fs = useFS()
  const ifs = useInputFS()
  const [task, setTask] = useState<RefPacketTask | null>(null)
  const [loading, setLoading] = useState(true)
  const [previewRoute, setPreviewRoute] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<RefPackSearchGroup[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<ScrollView>(null)
  const searchSectionY = useRef(0)
  // Kept in a ref (not a dep) so runSearch's identity stays stable for the
  // debounce and the element-tap handler.
  const taskRefsRef = useRef<string | null>(null)

  // Pass the task's own references_text so the search can be constrained to
  // the FAR parts the ACS actually cites, and so ACs it names by number get
  // pinned above keyword hits. Without it, "Pilot Qualifications" returned
  // § 135.23 (air carrier manual contents) purely on the word match.
  // isAcsSeeded: true when q comes from fixed FAA-authored ACS text (the
  // task's own title, or a Knowledge/Risk/Skill bullet's body) rather than
  // something a person actually typed -- see refPackSearch.ts's own
  // isAcsSeeded comment for why that distinction matters (a real free-typed
  // search always runs unconstrained).
  const runSearch = useCallback((q: string, isAcsSeeded = false) => {
    setSearchLoading(true)
    searchRefPackTopic(q, 4, taskRefsRef.current, isAcsSeeded)
      .then(setGroups)
      .finally(() => setSearchLoading(false))
  }, [])

  // Knowledge/Risk Management/Skills/Task Elements bullets are topic
  // phrases, not citations -- linkifyText finds nothing to link in most of
  // them ("Purpose and characteristics of effective assessment." has no
  // citation-shaped substring at all), so they rendered as fully dead text.
  // Tapping a bullet now reuses the exact same search infra as the box
  // above (searchRefPackTopic), just seeded with the bullet's own text
  // instead of the task title, and scrolls up to show the results --
  // "point to somewhere real in the app the user can get the actual info,"
  // not a second disconnected search UI.
  const handleTapElement = (bodyText: string) => {
    setQuery(bodyText)
    runSearch(bodyText, true)
    scrollRef.current?.scrollTo({ y: Math.max(0, searchSectionY.current - 12), animated: true })
  }

  useEffect(() => {
    if (!taskId || !hasPlusAccess) { setLoading(false); return }
    // hasPlusAccess resolves asynchronously after this screen's first mount
    // (isPro/isPremium/isUnlocked all start false in AuthContext) -- without
    // resetting loading back to true here, the guard above already set it
    // false on the first (hasPlusAccess=false) run, so the moment access
    // resolves true this effect re-fires but the screen skips straight past
    // the spinner and renders a blank/null task for the length of the real
    // fetch below. Same gap found+fixed in ref-packets/multi-engine.tsx
    // (which showed "AREA X · 0 TASKS" for the same reason) -- ref-packets/
    // [code].tsx's own identical effect already has this line.
    setLoading(true)
    getRefPacketTask(taskId).then((t) => {
      setTask(t)
      // Populate BEFORE the auto-search below fires, so the very first
      // result set is already constrained to the cited parts.
      taskRefsRef.current = t?.referencesText ?? null
      setLoading(false)
      // Auto-search on load using the task's own title -- this is what
      // "GUIDE them directly to that info" means in practice: the moment
      // you open a task, you already see the FAR/AIM/AC hits most relevant
      // to it, before typing anything.
      // NOTE: do NOT also setQuery(t.title) here. That used to pre-fill the
      // visible input with the title as real, editable text -- a single tap
      // (the normal way to start typing) dropped the cursor mid-string, so
      // keystrokes got inserted into "Regulatory Requirements" instead of
      // replacing it (e.g. typing "medical certificate" produced
      // "Regulatory Requiremedical certificatemen"). The box must render
      // its real placeholder and start with an actually-empty value; the
      // title-seeded results still populate below via runSearch alone.
      if (t) {
        runSearch(cleanAcsTaskTitleQuery(t.title), true)
      }
    })
  }, [taskId, runSearch, hasPlusAccess])

  const handleQueryChange = (v: string) => {
    setQuery(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(v), 300)
  }

  // Same guard as ref-packets/[code].tsx and multi-engine.tsx -- the effect
  // above fixed the "access resolved late" half of this race; this is the
  // other half, where the lock renders at a real Plus subscriber for as long
  // as auth's `loading` is still true.
  if (!hasPlusAccess && authLoading) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="RefPack" onBack={() => router.back()} />
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      </View>
    )
  }

  if (!hasPlusAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="RefPack" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.lockTitle, { color: tokens.t2, fontSize: fs(16) }]}>RefPacks are a Plus feature</Text>
          <Text style={[styles.lockSub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            Certificate and rating study guides, built from the FAA's own ACS/PTS standards — every reference
            already linked to the real FAR, AC, and AIM text.
          </Text>
          <Pressable style={[styles.lockBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall?tier=plus')}>
            <Text style={[styles.lockBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        title={task ? `Task ${task.taskLetter}` : 'Task'}
        onBack={() => router.back()}
      />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !task ? (
        // getRefPacketTask() resolves to null both when the task genuinely
        // doesn't exist AND on a real fetch error (it swallows Supabase
        // errors into a plain null return, same pattern as getRefPacket()
        // in this same lib) -- either way, `loading` finishes but `task`
        // never does. Before this fix, `loading || !task` kept showing the
        // spinner forever with no way to tell "still loading" from "never
        // going to load" -- a real infinite-spinner dead end, only escapable
        // via the header's back button.
        <View style={styles.center}>
          <Icon name="questionmark.circle" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.lockTitle, { color: tokens.t2, fontSize: fs(16) }]}>Task not found</Text>
          <Text style={[styles.lockSub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            This task couldn't be loaded. Check your connection and go back to try again.
          </Text>
        </View>
      ) : (
        <TabletContainer>
          <ScrollView ref={scrollRef} contentContainerStyle={styles.content} keyboardDismissMode="interactive">
            <View style={styles.breadcrumbRow}>
              <Pressable onPress={() => router.push(`/ref-packets/${task.docCode}` as any)}>
                <Text style={[styles.breadcrumbText, { color: tokens.t3, fontSize: fs(11.5) }]} numberOfLines={1}>{task.docTitle}</Text>
              </Pressable>
              <Icon name="chevron.right" size={fs(9)} color={tokens.t4} />
              <Text style={[styles.breadcrumbText, { color: tokens.t3, fontSize: fs(11.5) }]} numberOfLines={1}>
                Area {task.areaNumber}{task.areaTitle ? `: ${task.areaTitle}` : ''}
              </Text>
              <Icon name="chevron.right" size={fs(9)} color={tokens.t4} />
              <Text style={[styles.breadcrumbText, { color: tokens.t2, fontSize: fs(11.5), fontWeight: '700' }]} numberOfLines={1}>
                Task {task.taskLetter}
              </Text>
            </View>

            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(19), lineHeight: fs(19) * 1.37 }]}>{task.title}</Text>

            {task.objective && (
              <Section label="OBJECTIVE" tokens={tokens} fs={fs}>
                {splitIntoDisplayParagraphs(task.objective).map((para, i, arr) => (
                  <Text
                    key={i}
                    style={[styles.body, { color: tokens.t2, fontSize: fs(14), lineHeight: fs(14) * 1.5 }, i < arr.length - 1 && { marginBottom: 8 }]}
                  >
                    {para}
                  </Text>
                ))}
              </Section>
            )}

            <View
              style={styles.section}
              onLayout={(e) => { searchSectionY.current = e.nativeEvent.layout.y }}
            >
              <Text style={[styles.sectionLabel, { color: tokens.t3, fontSize: fs(11) }]}>RELATED REGULATIONS</Text>
              <View style={[styles.searchBar, { backgroundColor: tokens.inp, borderColor: tokens.bdr }]}>
                <Icon name="magnifyingglass" size={fs(15)} color={tokens.t3} />
                <TextInput
                  style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(13.5) }]}
                  value={query}
                  onChangeText={handleQueryChange}
                  placeholder="Search a topic — e.g. runway markings…"
                  placeholderTextColor={tokens.t4}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {searchLoading && <ActivityIndicator size="small" color={tokens.t3} />}
              </View>

              {!searchLoading && groups.length === 0 && query.trim().length >= 2 && (
                <Text style={[styles.emptySub, { color: tokens.t4, fontSize: fs(12.5) }]}>
                  Nothing in FAR, AIM, P/CG, or AC matches "{query}". This topic may only be covered in other FAA
                  materials (handbooks, PHAK, etc.) outside what FlyRegs indexes.
                </Text>
              )}

              {groups.map((g) => (
                <View key={g.type} style={styles.regGroup}>
                  <View style={styles.regGroupHeader}>
                    <Icon name={REG_TYPE[g.type].icon} size={fs(12)} color={tokens.blu} />
                    <Text style={[styles.regGroupLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>{REG_TYPE[g.type].label}</Text>
                  </View>
                  {g.results.map((r) => {
                    // AC is the one type whose `primary` glues a title onto the
                    // number ("AC 61-146 — Aviation Instructor's Handbook") --
                    // FAR/AIM/P/CG's primary is always just the bare id, so the
                    // number-vs-title contrast problem RC flagged only exists
                    // here. Reconstruct the number prefix from `id` (already the
                    // document_number) rather than splitting on " — ", which
                    // would break if a title ever legitimately contained one.
                    const acPrefix = `AC ${r.id}`
                    const isAc = r.type === 'ac' && r.primary.startsWith(acPrefix)
                    const acRest = isAc ? r.primary.slice(acPrefix.length) : ''
                    return (
                      <Pressable
                        key={`${r.type}-${r.id}`}
                        style={[styles.regRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                        onPress={() => setPreviewRoute(r.route)}
                      >
                        {/* No numberOfLines cap -- a long AC title ("AC 150/5210-7E
                            -- Aircraft Rescue and Fire...") used to cut off mid-word
                            with no way to read the rest. RC (repeated ask): "any
                            place in the app where a title runs off the page and
                            can't be read, we need to make adjustments to fix that.
                            full titles must be readable everywhere." regRow has no
                            fixed height, so wrapping just grows the row. Nesting
                            colored Text spans inside this one (rather than two
                            separate Text siblings) keeps that single uncapped flow
                            intact -- the number and title still wrap as one block. */}
                        <Text style={[styles.regPrimary, { fontSize: fs(13.5) }]}>
                          {isAc ? (
                            <>
                              <Text style={{ color: tokens.blu }}>{acPrefix}</Text>
                              <Text style={{ color: tokens.t1 }}>{highlightSpans(acRest, query, { redShift })}</Text>
                            </>
                          ) : (
                            <Text style={{ color: tokens.blu }}>{highlightSpans(r.primary, query, { redShift })}</Text>
                          )}
                        </Text>
                        {!!r.secondary && (
                          <Text style={[styles.regSecondary, { color: tokens.t3, fontSize: fs(12), lineHeight: fs(12) * 1.33 }]} numberOfLines={2}>
                            {highlightSpans(r.secondary, query, { redShift })}
                          </Text>
                        )}
                      </Pressable>
                    )
                  })}
                </View>
              ))}
            </View>

            {task.referencesText && (
              <Section label="FAA REFERENCES" tokens={tokens} fs={fs}>
                {splitIntoDisplayParagraphs(task.referencesText).map((para, i, arr) => (
                  <Text
                    key={i}
                    style={[styles.body, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.5 }, i < arr.length - 1 && { marginBottom: 8 }]}
                  >
                    {para}
                  </Text>
                ))}
              </Section>
            )}

            <ElementGroup label="KNOWLEDGE" items={task.knowledge} tokens={tokens} fs={fs} onOpenPreview={setPreviewRoute} onTapElement={handleTapElement} hasProAccess={hasProAccess} />
            <ElementGroup label="RISK MANAGEMENT" items={task.riskManagement} tokens={tokens} fs={fs} onOpenPreview={setPreviewRoute} onTapElement={handleTapElement} hasProAccess={hasProAccess} />
            <ElementGroup label="SKILLS" items={task.skills} tokens={tokens} fs={fs} onOpenPreview={setPreviewRoute} onTapElement={handleTapElement} hasProAccess={hasProAccess} />
            <ElementGroup label="TASK ELEMENTS" items={task.topics} tokens={tokens} fs={fs} onOpenPreview={setPreviewRoute} onTapElement={handleTapElement} hasProAccess={hasProAccess} />
          </ScrollView>
        </TabletContainer>
      )}
      <RegPreviewPane route={previewRoute} highlightQuery={query} onClose={() => setPreviewRoute(null)} />
    </View>
  )
}

function Section({
  label,
  tokens,
  fs,
  children,
}: {
  label: string
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  children: React.ReactNode
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionLabel, { color: tokens.t3, fontSize: fs(11) }]}>{label}</Text>
      {children}
    </View>
  )
}

function ElementGroup({
  label,
  items,
  tokens,
  fs,
  onOpenPreview,
  onTapElement,
  hasProAccess,
}: {
  label: string
  items: RefPacketElement[]
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  onOpenPreview: (route: string) => void
  onTapElement: (bodyText: string) => void
  hasProAccess: boolean
}) {
  if (items.length === 0) return null
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionLabel, { color: tokens.t3, fontSize: fs(11) }]}>{label}</Text>
      <Text style={[styles.elementHint, { color: tokens.t4, fontSize: fs(11.5), lineHeight: fs(11.5) * 1.3 }]}>
        Tap any item below to search Related Regulations above for it.
      </Text>
      <View style={[styles.elementCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
        {items.map((el, i) => (
          <Pressable
            key={el.code}
            onPress={() => onTapElement(el.bodyText)}
            style={[styles.elementRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.bdr }]}
          >
            <Text style={[styles.elementCode, { color: tokens.blu, fontSize: fs(11.5) }]}>{el.code}</Text>
            {splitIntoDisplayParagraphs(el.bodyText).map((para, pi, parr) => (
              <Text
                key={pi}
                style={[styles.elementBody, { color: tokens.t2, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }, pi < parr.length - 1 && { marginBottom: 6 }]}
              >
                {linkifyText(para).map((seg, i) =>
                  seg.route ? (
                    <Text
                      key={i}
                      onPress={(e) => {
                        e.stopPropagation()
                        if (!hasProAccess) { router.push('/paywall?tier=pro' as any); return }
                        onOpenPreview(seg.route as string)
                      }}
                      style={{ color: tokens.blu, fontWeight: '600' }}
                    >
                      {seg.text}
                    </Text>
                  ) : (
                    <Text key={i}>{seg.text}</Text>
                  ),
                )}
              </Text>
            ))}
            <Icon name="magnifyingglass" size={fs(13)} color={tokens.t4} />
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 48, gap: 4 },

  lockTitle: { fontWeight: '600', marginTop: 6 },
  // lineHeight NOT set here -- always overridden inline with fs(13.5) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  lockSub: { textAlign: 'center', maxWidth: 300 },
  lockBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, marginTop: 10 },
  lockBtnText: { color: '#fff', fontWeight: '700' },

  breadcrumbRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 10, flexWrap: 'wrap' },
  breadcrumbText: { fontWeight: '500' },

  // lineHeight NOT set here -- always overridden inline with fs(19) * 1.37
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  title: { fontWeight: '700', marginBottom: 4 },

  section: { marginTop: 16 },
  sectionLabel: { fontWeight: '600', letterSpacing: 0.6, marginBottom: 8 },
  // lineHeight NOT set here -- always overridden inline with fs(11.5) * 1.3
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  elementHint: { marginTop: -4, marginBottom: 8 },
  // lineHeight NOT set here -- always overridden inline with fs(size) * 1.5
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  body: {},
  emptySub: { marginTop: 8 },

  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
  },
  searchInput: { flex: 1, paddingVertical: 0 },

  regGroup: { marginTop: 12, gap: 6 },
  regGroupHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  regGroupLabel: { fontWeight: '700', letterSpacing: 0.6 },
  regRow: { borderRadius: 10, borderWidth: 1, padding: 10, gap: 2 },
  regPrimary: { fontWeight: '700' },
  // lineHeight NOT set here -- always overridden inline with fs(12) * 1.33
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  regSecondary: {},

  elementCard: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  elementRow: { flexDirection: 'row', gap: 10, padding: 12 },
  elementCode: { fontWeight: '700', width: 74 },
  // lineHeight NOT set here -- always overridden inline with fs(13.5) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  elementBody: { flex: 1 },
})
