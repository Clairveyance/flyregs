import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Share } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import * as Sentry from '@sentry/react-native'
import * as Haptics from 'expo-haptics'
import * as Clipboard from 'expo-clipboard'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { printReg } from '@/lib/printReg'
import { PlainTextBody, PlainTextBodyHandle } from '@/components/PlainTextBody'
import { MagicLinkPod } from '@/components/MagicLinkPod'
import { TabletContainer } from '@/components/TabletContainer'
import { FolderPicker } from '@/components/FolderPicker'
import { HeaderOverflowMenu } from '@/components/HeaderOverflowMenu'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { BackToBreadcrumb, PrevNextFooter } from '@/components/DocNavBar'
import { InDocSearchBar } from '@/components/InDocSearchBar'
import { useInDocSearch } from '@/lib/useInDocSearch'
import { isBookmarked, toggleBookmark, getHighlightsForAC, findHighlight, addHighlight, removeHighlight } from '@/lib/bookmarks'
import { isDownloaded, addDownload, removeDownload, findDownload } from '@/lib/downloads'
import { DetailActionRow } from '@/components/DetailMeta'
import { addRecent } from '@/lib/recents'
import { consumePendingBreadcrumb } from '@/lib/navBreadcrumb'
import { buildRegShareLink } from '@/lib/regShare'
import { getLatestRevision, changedParagraphIndices, splitParagraphs, type ContentRevision } from '@/lib/whatsChanged'
import { stripFarPrefix } from '@/lib/titleFormat'
import { normalizeRegBody } from '@/lib/regTextFormat'
import { fetchMnemonicAnchors, MnemonicAnchor } from '@/lib/regMnemonics'
import { useConfirm } from '@/components/ConfirmDialog'

// Natural-sort section numbers ("91.3" before "91.107") for Prev/Next --
// same comparator far/part/[part].tsx already uses to browse a Part.
function compareSectionNumbers(a: string, b: string): number {
  const an = parseFloat(a)
  const bn = parseFloat(b)
  if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn
  return a.localeCompare(b)
}

// FlyRegs pricing pivot (2026-07-24): full regulation text is free to read —
// see PROJECT_NOTES/flyregs_decisions.md, "Pricing model pivot". Paid tiers
// gate Study/Ref Packets, What's Changed, highlights/notes, sync, and
// collaboration — never the regulation text itself.

interface FarSection {
  section_number: string
  part: string
  subpart_letter: string | null
  subpart_title: string | null
  title: string | null
  body_text: string | null
}

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

export default function FarSectionScreen() {
  const { id, hl } = useLocalSearchParams<{ id: string; hl?: string }>()
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const { hasPlusAccess, hasProAccess, isPremium } = useAuth()
  const [section, setSection] = useState<FarSection | null>(null)
  const [related, setRelated] = useState<RelatedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [bookmarked, setBookmarked] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [folderPickerVisible, setFolderPickerVisible] = useState(false)
  const [confirmLabel, setConfirmLabel] = useState<string | undefined>()
  const [confirmTick, setConfirmTick] = useState(0)
  const [backTo, setBackTo] = useState<string | null>(null)
  const [siblingSections, setSiblingSections] = useState<string[]>([])
  const [scrollY, setScrollY] = useState(0)
  const [tablesExpanded, setTablesExpanded] = useState(false)
  const [scrollViewportHeight, setScrollViewportHeight] = useState<number | undefined>(undefined)
  const scrollRef = useRef<ScrollView>(null)
  const bodyRef = useRef<PlainTextBodyHandle>(null)
  const inDocSearch = useInDocSearch(bodyRef)

  // Opened from a Study Mode flashcard bookmark, which stored the passage
  // the Q/A came from (see study.tsx + routeForBookmark). Seeding the in-doc
  // search with it reuses the existing highlight + auto-scroll-to-first-match
  // path, so the reg opens AT that passage rather than at the top. Runs once
  // per distinct hl value; a normal visit has no param and is unaffected.
  useEffect(() => {
    if (id) isDownloaded(id).then(setDownloaded)
  }, [id])

  const seededHlRef = useRef<string | null>(null)
  useEffect(() => {
    if (typeof hl !== 'string' || !hl.trim()) return
    if (seededHlRef.current === hl) return
    seededHlRef.current = hl
    inDocSearch.onQueryChange(hl)
  }, [hl, inDocSearch])

  // What's Changed parity with AC: pull this document's most recent
  // revision so the changed paragraphs can be flagged inline and jumped to.
  // AC gets this from its own changed_block_indices column; FAR/AIM have no
  // such column, so the indices are derived from the revision's added_text.
  const [revision, setRevision] = useState<ContentRevision | null>(null)
  useEffect(() => {
    if (!id) return
    getLatestRevision('far', id).then(setRevision).catch(() => setRevision(null))
  }, [id])

  // Curated memory-aid highlights (AVE-F, MEA's lost-comm sense, etc.) --
  // empty for the overwhelming majority of sections, so this is a cheap
  // no-op fetch most of the time. See src/lib/regMnemonics.ts.
  const [mnemonicAnchors, setMnemonicAnchors] = useState<MnemonicAnchor[]>([])
  useEffect(() => {
    if (!id) return
    fetchMnemonicAnchors('far', id).then(setMnemonicAnchors).catch(() => setMnemonicAnchors([]))
  }, [id])

  const changedIdx = useMemo(
    () => changedParagraphIndices(section?.body_text ?? '', revision?.addedText ?? null),
    [section?.body_text, revision],
  )
  const [changedCursor, setChangedCursor] = useState(0)
  const jumpToChanged = (dir: 1 | -1) => {
    if (changedIdx.length === 0) return
    const next = (changedCursor + dir + changedIdx.length) % changedIdx.length
    setChangedCursor(next)
    setTimeout(() => bodyRef.current?.scrollToParagraph(changedIdx[next]), 60)
  }

  useEffect(() => {
    if (id) isBookmarked(id).then(setBookmarked)
  }, [id])

  // Passage-level highlighting -- FAR/AIM/AD/LOI never had this at all
  // (only AC did, see bookmarks.ts's Highlights section); ported over so
  // long-pressing a paragraph here works exactly the same way.
  const [highlightedBlockTexts, setHighlightedBlockTexts] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!id) return
    getHighlightsForAC(id, 'far').then((hs) => setHighlightedBlockTexts(new Set(hs.map((h) => h.blockText!))))
  }, [id])
  // The passage currently under the Copy/Highlight menu, shown as a
  // "SELECTED" preview -- see PlainTextBody's pendingBlockText comment.
  const [pendingHighlight, setPendingHighlight] = useState<string | null>(null)

  // Consumed once per screen instance (on mount / id change), not on every
  // render -- see navBreadcrumb.ts's single-slot design.
  useEffect(() => {
    setBackTo(consumePendingBreadcrumb())
  }, [id])

  useEffect(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      supabase
        .from('far_sections')
        .select('section_number, part, subpart_letter, subpart_title, title, body_text')
        .eq('section_number', id)
        .single(),
      // Both directions — a FAR section can be cited BY an AC/AIM/PCG entry,
      // and can cite outward too (far_citations.py). Association bars
      // always show, "0" when empty — see the expansion plan's locked-in
      // empty-state decision.
      supabase
        .from('document_citations')
        .select('citing_type, citing_id, cited_type, cited_id, label')
        .or(`and(cited_type.eq.far,cited_id.eq.${id}),and(citing_type.eq.far,citing_id.eq.${id})`),
    ]).then(async ([secRes, citRes]) => {
      if (!secRes.error && secRes.data) {
        const s = secRes.data as FarSection
        setSection(s)
        addRecent({
          id: s.section_number,
          itemType: 'far',
          document_number: `§ ${s.section_number}`,
          title: s.title ?? '',
          date_issued: null,
          subject_series: null,
        })
      } else {
        // No network (or the row is gone): fall back to the offline copy if
        // this section was downloaded. Without this branch, "Download" is
        // write-only storage — the user saves a section, loses signal, opens
        // it, and gets an empty screen, which is exactly the case the feature
        // exists for. Citations/figures aren't cached, so the offline view is
        // the regulation text itself; that's the part that matters with no
        // connection.
        const cached = await findDownload(id)
        if (cached) {
          setSection({
            section_number: cached.document_number.replace(/^§\s*/, ''),
            part: cached.subject_series ?? '',
            subpart_letter: null,
            subpart_title: null,
            title: cached.title,
            body_text: cached.body_text ?? null,
          })
        }
      }
      if (!citRes.error && citRes.data) {
        // Normalize to "the OTHER document" regardless of which side of the
        // row this section is on — same fix as aim/[id].tsx: the old query
        // only ever read cited_type/cited_id, so an inbound row (someone
        // else citing THIS section) displayed as if it pointed at itself.
        const rows = citRes.data as {
          citing_type: string; citing_id: string; cited_type: string; cited_id: string; label: string | null
        }[]
        const other = rows
          .map((r) => (r.citing_type === 'far' && r.citing_id === id
            ? { cited_type: r.cited_type, cited_id: r.cited_id, label: r.label }
            : { cited_type: r.citing_type, cited_id: r.citing_id, label: r.label }))
          .filter((r) => !(r.cited_type === 'far' && r.cited_id === id))
        setRelated(other)
      }
      setLoading(false)
    })
  }, [id])

  // Sibling section numbers within this section's own Part, for Prev/Next --
  // a lightweight second query once the Part is known, not blocking the
  // section's own load above.
  useEffect(() => {
    if (!section?.part) return
    supabase
      .from('far_sections')
      .select('section_number')
      .eq('part', section.part)
      .then(({ data }) => {
        if (data) {
          setSiblingSections(
            (data as { section_number: string }[])
              .map((r) => r.section_number)
              // "§§ 91.27-91.99 [Reserved]"-style rows use a hyphenated
              // range as their section_number instead of a real single
              // section -- confirmed live as a real bug: Prev/Next from
              // § 91.3 landed on this placeholder instead of skipping to
              // the next real section. Verified all 36 hyphenated rows
              // app-wide are reserved placeholders, zero real content, so
              // this exclusion is safe everywhere, not just Part 91.
              .filter((n) => !n.includes('-'))
              .sort(compareSectionNumbers),
          )
        }
      })
  }, [section?.part])

  const siblingIdx = section ? siblingSections.indexOf(section.section_number) : -1
  const prevSection = siblingIdx > 0 ? siblingSections[siblingIdx - 1] : null
  const nextSection = siblingIdx >= 0 && siblingIdx < siblingSections.length - 1 ? siblingSections[siblingIdx + 1] : null

  const body = section?.body_text ?? ''
  const currentLabel = section ? `§ ${section.section_number}` : undefined
  // FAR has no dedicated figures table (ac_figures/aim_figures) -- its
  // "tables" are real pipe-delimited rows embedded directly in body_text
  // (confirmed: 93 sections, e.g. $ 47.17's fee schedule), the exact same
  // pattern filter_documents' p_has_figures already detects server-side.
  // PlainTextBody already renders these as a real grid inline. Indices are
  // in PlainTextBody's own paragraph-split space (NOT a raw "\n\n" split),
  // so scrollToParagraph's index always lines up with what actually
  // rendered.
  const bodyParagraphs = normalizeRegBody(body).split(/\n\n+/).filter((p) => p.trim())
  // RC, real device on FAR 120.117 (3 tables in one section): tapping the
  // bar jumped straight to the first table with no way to reach the other
  // two -- fine for AC/AIM (their Figures & Tables bar already expands a
  // list to choose from before opening anything), broken here since the
  // bar used to jump immediately. Every table paragraph gets its own entry
  // now, labeled from whichever lettered/numbered marker starts the
  // paragraph right before it (FAR almost always introduces a table with
  // "(a) Use the following chart..."), falling back to a plain ordinal
  // ("Table 2") when no such marker exists.
  const LEADING_MARKER_RE = /^(\([a-zA-Z0-9]{1,4}\)|[a-zA-Z0-9]{1,3}\.)\s+/
  const tables = bodyParagraphs
    .map((para, i) => ({ para, i }))
    .filter(({ para }) => para.split('\n').filter((l) => l.includes(' | ')).length >= 2)
    .map(({ i }, n, arr) => {
      const marker = bodyParagraphs[i - 1]?.match(LEADING_MARKER_RE)?.[1]
      return { paraIndex: i, label: marker ? `Table ${marker}` : arr.length > 1 ? `Table ${n + 1}` : 'Table' }
    })
  const tableCount = tables.length
  const firstTableParaIndex = tables[0]?.paraIndex ?? -1

  const aimRefs = related.filter((r) => r.cited_type === 'aim')
  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const pcgRefs = related.filter((r) => r.cited_type === 'pcg')
  const adRefs = related.filter((r) => r.cited_type === 'ad')
  const loiRefs = related.filter((r) => r.cited_type === 'loi')

  const handleToggleBookmark = async () => {
    if (!section) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setBookmarked((prev) => !prev) // optimistic
    const next = await toggleBookmark({
      id: section.section_number,
      itemType: 'far',
      document_number: `§ ${section.section_number}`,
      title: section.title ?? '',
      date_issued: null,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  // Same 800ms cooldown + in-flight guard as ac/[id].tsx's own
  // handleToggleHighlight -- RN Web's Pressable long-press timer path fired
  // onLongPress repeatedly for what was really one held gesture there;
  // porting the exact same guard rather than re-deriving it.
  const toggleInFlight = useRef(false)
  const lastToggleAt = useRef(0)
  const handleToggleHighlight = useCallback(async (paraText: string) => {
    if (!section) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    if (toggleInFlight.current) return
    if (Date.now() - lastToggleAt.current < 800) return
    lastToggleAt.current = Date.now()
    toggleInFlight.current = true
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      const existing = await findHighlight(section.section_number, paraText, 'far')
      if (existing) {
        await removeHighlight(existing.id)
      } else {
        await addHighlight({
          acId: section.section_number,
          itemType: 'far',
          document_number: `§ ${section.section_number}`,
          title: section.title ?? '',
          date_issued: null,
          office: null,
          subject_series: null,
          blockKind: 'para',
          blockLabel: null,
          blockSnippet: paraText.slice(0, 100),
          blockText: paraText,
        })
      }
      const highlights = await getHighlightsForAC(section.section_number, 'far')
      setHighlightedBlockTexts(new Set(highlights.map((h) => h.blockText!)))
    } finally {
      toggleInFlight.current = false
    }
  }, [section, hasPlusAccess])

  const handleCopyBlock = useCallback(async (paraText: string) => {
    await Clipboard.setStringAsync(paraText)
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
  }, [])

  const handleBlockLongPress = useCallback((paraText: string) => {
    if (!hasPlusAccess) { router.push('/paywall'); return }
    // Set BEFORE the menu opens, not after a choice -- RC: "the h/l feature
    // needs to show the h/l area in the doc before any CTA pops up w/
    // options." Cleared on every dismiss path (any choice, Cancel, or
    // tapping outside), so it never sticks around.
    setPendingHighlight(paraText)
    const isHighlighted = highlightedBlockTexts.has(paraText)
    confirm({
      title: 'Passage',
      choices: [
        { label: 'Copy Text', onPress: () => { setPendingHighlight(null); handleCopyBlock(paraText) } },
        {
          label: isHighlighted ? 'Remove Highlight' : 'Highlight',
          onPress: () => { setPendingHighlight(null); handleToggleHighlight(paraText) },
        },
      ],
      onCancel: () => setPendingHighlight(null),
    })
  }, [hasPlusAccess, highlightedBlockTexts, handleCopyBlock, handleToggleHighlight])

  const handleOpenFolderPicker = () => {
    if (!section) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setFolderPickerVisible(true)
  }

  // Premium-gated like AC/AD/LOI's download. The `!downloaded` guard on the
  // paywall check is deliberate and matches the others: a user who lapses
  // from Premium can still REMOVE what they already saved, rather than being
  // stuck with undeletable offline copies behind a paywall.
  const handleDownload = async () => {
    if (!section) return
    if (!isPremium && !downloaded) { router.push('/paywall?tier=premium'); return }
    if (downloaded) {
      setDownloaded(false)
      await removeDownload(section.section_number)
      return
    }
    setDownloadBusy(true)
    try {
      await addDownload({
        id: section.section_number,
        type: 'far',
        document_number: `§ ${section.section_number}`,
        title: section.title ?? '',
        // subject_series is a free-form slot on DownloadedAC; FAR reuses it to
        // carry the Part number so the offline header reads "FAR — Part 91"
        // instead of a bare "FAR — Part".
        subject_series: section.part,
        size: (section.body_text ?? '').length,
        body_text: section.body_text ?? null,
      })
      setDownloaded(true)
    } catch {
      confirm({ title: 'Error', message: "Couldn't save this section for offline reading. Try again in a moment.", cancelLabel: null })
    }
    setDownloadBusy(false)
  }

  // Print is the other half of the Plus "Print & export any section"
  // promise -- until now the app had no print at all, only the share
  // sheet (which exports a LINK, not the text).
  const handlePrint = async () => {
    if (!hasPlusAccess) { router.push('/paywall'); return }
    if (!section) return
    try {
      await printReg({
        documentNumber: `§ ${section.section_number}`,
        title: section.title,
        body: section.body_text ?? '',
        kindLabel: 'FAR',
      })
    } catch (err) {
      // See ac/[id].tsx's handlePrint for the full reasoning -- expo-print
      // on iOS can reject AFTER the system print sheet already opened and
      // was used, so alerting the user that it "couldn't open" is often
      // just wrong by the time this fires. Log only, don't tell them
      // something untrue.
      Sentry.captureException(err)
    }
  }

  const handleShare = async () => {
    // Share/export is a PLUS feature (paywall PLUS_FEATURES), not Premium.
    // Gating it on isPremium bounced a Plus buyer to a Premium upsell for
    // something they had already paid for.
    if (!hasPlusAccess) { router.push('/paywall'); return }
    if (!section) return
    try {
      await Share.share({
        title: `§ ${section.section_number}`,
        message: buildRegShareLink('far', section.section_number, `§ ${section.section_number}`, section.title ?? undefined),
      })
    } catch {
      // User cancelled or share unavailable
    }
  }

  const headerRight = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      {scrollY > 200 && (
        <Pressable
          onPress={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
          hitSlop={12}
          style={{ padding: 4 }}
        >
          <Icon name="arrow.up.circle" size={fs(21)} color={tokens.t3} />
        </Pressable>
      )}
      <HeaderOverflowMenu
        items={[
          { icon: 'printer', label: 'Print', onPress: handlePrint, disabled: !hasPlusAccess },
          { icon: 'square.and.arrow.up', label: 'Share', onPress: handleShare, disabled: !hasPlusAccess },
          { icon: 'folder.badge.plus', label: 'Add to Folder', onPress: handleOpenFolderPicker, disabled: !hasPlusAccess },
        ]}
      />
      <Pressable onPress={handleToggleBookmark} hitSlop={12} style={{ padding: 4 }}>
        <Icon
          name={bookmarked ? 'bookmark.fill' : 'bookmark'}
          size={fs(21)}
          color={bookmarked ? tokens.blu : tokens.t2}
        />
      </Pressable>
    </View>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      {/* Same fix as AIM's header — "Part 91" alone doesn't say WHICH
          regulation you're in once the app spans multiple sources. */}
      <OverlayHeader title={`FAR — Part ${section?.part ?? id?.split('.')[0] ?? ''}`} onBack={() => router.back()} right={headerRight} />
      {backTo && <BackToBreadcrumb label={backTo} onPress={() => router.back()} />}
      {!loading && section && (
        <InDocSearchBar
          query={inDocSearch.query}
          onQueryChange={inDocSearch.onQueryChange}
          onClear={inDocSearch.onClear}
          matchCount={inDocSearch.matchCount}
          matchIdx={inDocSearch.matchIdx}
          onPrev={inDocSearch.goToPrev}
          onNext={inDocSearch.goToNext}
        />
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !section ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>Section not found.</Text>
        </View>
      ) : (
        <TabletContainer>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
          onLayout={(e) => setScrollViewportHeight(e.nativeEvent.layout.height)}
          scrollEventThrottle={100}
        >
          {section.subpart_title && (
            <Text style={[styles.subpart, { color: tokens.t3, fontSize: fs(12) }]}>{section.subpart_title}</Text>
          )}
          <Text style={[styles.secNum, { color: tokens.blu, fontSize: fs(15) }]}>§ {section.section_number}</Text>
          {section.title && (
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>{stripFarPrefix(section.title)}</Text>
          )}

          {/* Download only — the FARs come from eCFR XML and have no PDF to
              open, so this renders the Download button full width rather
              than pairing it with an "Open PDF" that couldn't work. */}
          <View style={{ marginTop: 18 }}>
            <DetailActionRow
              onDownload={handleDownload}
              downloaded={downloaded}
              downloadBusy={downloadBusy}
              tokens={tokens}
            />
          </View>

          <View style={[styles.barsWrap]}>
            {/* Always shown, even at 0 -- matches AC's ACBody.tsx and AIM's
                Figures & Tables bar (both explicitly "always shown once
                loaded, even at 0, so it doesn't look like the feature is
                broken/missing data"). This bar used to hide entirely below
                tableCount > 0, which RC caught live on FAR 91.107 (0 real
                tables): the whole row vanished instead of reading "Tables
                0" the way every other reg type does. */}
            <Pressable
              style={[styles.tablesBar, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              // RC, real device on FAR 120.117 (3 tables in one section):
              // "tapping the T&F bar shouldn't immediately jump to a T&F...
              // it should show a dropdown menu of the T&Fs... THEN you
              // select which one." Matches AC's own Figures & Tables bar,
              // which always expands a list first, even for a single item,
              // rather than ever jumping straight to content on the bar tap
              // itself -- same expand-then-choose pattern here.
              onPress={() => {
                if (tableCount > 0) setTablesExpanded((e) => !e)
              }}
              disabled={tableCount === 0}
            >
              <Icon name="photo" size={fs(15)} color={tokens.t3} />
              <Text style={[styles.tablesBarLabel, { color: tableCount > 0 ? tokens.blu : tokens.t1, fontSize: fs(13) }]}>
                {tableCount === 1 ? 'Table' : 'Tables'}
              </Text>
              <View style={{ flex: 1 }} />
              <Text style={[styles.tablesBarCount, { color: tokens.t3, fontSize: fs(12.5) }]}>{tableCount}</Text>
              {tableCount > 0 && <Icon name={tablesExpanded ? 'chevron.up' : 'chevron.down'} size={fs(11)} color={tokens.blu} />}
            </Pressable>
            {tablesExpanded && tableCount > 0 && (
              <View style={[styles.tablesList, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {tables.map((t, i) => (
                  <Pressable
                    key={t.paraIndex}
                    style={[styles.tablesListRow, i > 0 && { borderTopWidth: 1, borderTopColor: tokens.bdr }]}
                    onPress={() => {
                      setTablesExpanded(false)
                      bodyRef.current?.scrollToParagraph(t.paraIndex)
                    }}
                  >
                    <Icon name="square.grid.2x2" size={fs(13)} color={tokens.blu} />
                    <Text style={{ color: tokens.t1, fontSize: fs(13.5), fontWeight: '600', flex: 1 }}>
                      {t.label}{currentLabel ? ` — ${currentLabel}` : ''}
                    </Text>
                    <Icon name="chevron.right" size={fs(11)} color={tokens.t4} />
                  </Pressable>
                ))}
              </View>
            )}
            <MagicLinkPod
              bars={[
                { icon: 'doc.text', label: 'Related ACs', items: acRefs },
                { icon: 'list.bullet', label: 'AIM references', items: aimRefs },
                { icon: 'questionmark.circle', label: 'P/CG terms', items: pcgRefs },
                { icon: 'wrench.and.screwdriver', label: 'Related ADs', items: adRefs },
                { icon: 'checkmark.seal.fill', label: 'Related LOIs', items: loiRefs },
              ]}
              currentLabel={currentLabel}
              hasProAccess={hasProAccess}
            />
          </View>

            {changedIdx.length > 0 && (
              <View style={[styles.changedBanner, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                <Icon name="doc.badge.clock" size={fs(13)} color={tokens.blu} />
                <Text style={[styles.changedBannerText, { color: tokens.blu, fontSize: fs(12.5) }]}>
                  Updated — {changedIdx.length} paragraph{changedIdx.length === 1 ? '' : 's'} changed
                </Text>
                <Pressable onPress={() => jumpToChanged(-1)} hitSlop={8}>
                  <Icon name="chevron.up" size={fs(14)} color={tokens.blu} />
                </Pressable>
                <Pressable onPress={() => jumpToChanged(1)} hitSlop={8}>
                  <Icon name="chevron.down" size={fs(14)} color={tokens.blu} />
                </Pressable>
              </View>
            )}
          {body ? (
            <PlainTextBody
              ref={bodyRef}
              text={body}
              currentLabel={currentLabel}
              highlightQuery={inDocSearch.debounced}
              activeMatch={inDocSearch.matchIdx}
              changedIndices={changedIdx}
              onMatchCount={inDocSearch.setMatchCount}
              scrollRef={scrollRef}
              viewportHeight={scrollViewportHeight}
              mnemonicAnchors={mnemonicAnchors}
              highlightedBlockTexts={highlightedBlockTexts}
              onToggleHighlight={(paraText) => handleBlockLongPress(paraText)}
              pendingBlockText={pendingHighlight}
            />
          ) : /reserved/i.test(section.title || '') ? (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>
              This section is currently reserved by the FAA — it has no active regulatory text.
              Documents citing it did so while it held different content, or reference it for
              numbering purposes only.
            </Text>
          ) : (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>No text available for this section.</Text>
          )}
        </ScrollView>
        </TabletContainer>
      )}
      {section && (
        <PrevNextFooter
          prevLabel={prevSection ? `§ ${prevSection}` : null}
          nextLabel={nextSection ? `§ ${nextSection}` : null}
          onPrev={() => prevSection && router.replace(`/far/${prevSection}` as any)}
          onNext={() => nextSection && router.replace(`/far/${nextSection}` as any)}
        />
      )}
      <FolderPicker
        visible={folderPickerVisible}
        itemType="far"
        itemId={section?.section_number ?? ''}
        onClose={() => setFolderPickerVisible(false)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={section ? {
          document_number: `§ ${section.section_number}`,
          title: section.title ?? '',
          date_issued: null,
          office: null,
          subject_series: null,
        } : undefined}
      />
      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
    </View>
  )
}

const styles = StyleSheet.create({
  changedBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 12 },
  changedBannerText: { fontWeight: '700', flex: 1 },

  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { fontSize: 15, textAlign: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  subpart: { fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  secNum: { fontWeight: '600', fontSize: 15 },
  title: { fontWeight: '600', fontSize: 17, marginTop: 2, marginBottom: 14, lineHeight: 23 },
  // Breathing room around the action/MagicLink stack. These bars used to
  // butt straight up against the Download button above and the body text
  // below, so the whole block read as one cramped slab.
  // marginTop matches the internal `gap` -- see aim/[id].tsx's own comment
  // (RC, annotated screenshot): the two gaps were 14px and 10px, uneven.
  barsWrap: { gap: 10, marginTop: 10, marginBottom: 22 },
  tablesBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
  },
  tablesBarLabel: { fontWeight: '600' },
  tablesBarCount: { fontWeight: '500' },
  tablesList: { borderRadius: 12, borderWidth: 1, marginTop: -4, overflow: 'hidden' },
  tablesListRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 11 },
  body: { fontSize: 14.5, lineHeight: 22 },
})
