import { useEffect, useState, useRef } from 'react'
import { Modal, View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'
import { parsePreviewRoute, fetchRegPreview, resolveAimFigureGlobally, RegPreviewData } from '@/lib/regPreview'
import { isBookmarked, toggleBookmark } from '@/lib/bookmarks'
import { FolderPicker } from '@/components/FolderPicker'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { PlainTextBody, PlainTextBodyHandle } from '@/components/PlainTextBody'
import { FigureViewer } from '@/components/FigureViewer'
import { stripFarPrefix } from '@/lib/titleFormat'
import { useInDocSearch } from '@/lib/useInDocSearch'
import type { AcFigure } from '@/types'

interface PreviewFigure {
  id: string
  label: string | null
  caption: string | null
  image_url: string
}

// All the fetch/state/handler logic RegPreviewChrome needs, pulled out of
// the component itself so it's exactly one implementation regardless of
// whether the caller wants it in a Modal sheet (RegPreviewPane) or a
// persistent side pane (RegPreviewInline, for the iPad landscape
// master-detail split -- see SplitPane.tsx callers).
function useRegPreviewContent(route: string | null, onClose: () => void, highlightQuery?: string) {
  const { hasPlusAccess, hasProAccess, loading: authLoading } = useAuth()
  const [data, setData] = useState<RegPreviewData | null>(null)
  // Carries the search term the user typed into a RefPack task's "Related
  // Regulations" box (or any other future caller) into this peek so the
  // exact same in-doc highlight + prev/next-arrow jump the full FAR/AIM/etc
  // detail screens already have works here too, without ever leaving the
  // RP -- RC: "this ENTIRE process MUST take place in and STAY inside the
  // RP." Only the TOP-level preview gets it; tapping a cross-reference
  // inside opens a nested preview for different content, a separate
  // context that was never what the user searched for.
  const bodyRef = useRef<PlainTextBodyHandle>(null)
  const scrollRef = useRef<ScrollView>(null)
  const [viewportHeight, setViewportHeight] = useState(0)
  const inDocSearch = useInDocSearch(bodyRef)
  useEffect(() => {
    inDocSearch.onQueryChange(highlightQuery ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, highlightQuery])
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  // AIM's own figures/tables for the previewed paragraph -- fetched
  // alongside the body text so a "(See FIG x-x-x.)" mention inside this
  // preview can open the real image instead of silently falling through to
  // PlainTextBody's route-guess fallback. FAR has no dedicated figures
  // table (its tables are inline in body_text, handled by PlainTextBody's
  // own parseTableBlock), so this only ever populates for kind==='aim'.
  const [figures, setFigures] = useState<PreviewFigure[]>([])
  const [viewerFigure, setViewerFigure] = useState<AcFigure | null>(null)
  // "Added to X" confirmation -- every other screen with a FolderPicker
  // wires this (see ac/far/aim/pcg/ad/loi [id].tsx, notes/recents/saved.tsx);
  // this one never did, confirmed live as a real gap: saving to a folder
  // from inside a RefPack/notes/shared-folder preview happened silently,
  // with no toast anywhere -- because RegPreviewPane is the ONE shared
  // component all of those screens render their FolderPicker through.
  const [confirmTick, setConfirmTick] = useState(0)
  const [confirmLabel, setConfirmLabel] = useState('')
  // Tapping a citation INSIDE this preview opens a nested RegPreviewPane
  // (always the Modal variant, even when the base content here is the
  // persistent pane variant -- "a quick peek at a cross-reference"
  // deliberately stays a temporary overlay rather than replacing what's
  // pinned in the split pane) instead of navigating away -- confirmed live
  // as a real bug/ask: "inside that reg are hyperlinks to other regs and
  // T&Fs... if you click on those, the app needs to open another half
  // screen over that half screen... this ENTIRE process MUST take place in
  // and STAY inside the RP." Closing the nested sheet just clears this
  // state, revealing whatever's still mounted underneath -- unlimited depth
  // for free, no stack data structure needed since each level owns its own
  // childRoute.
  const [childRoute, setChildRoute] = useState<string | null>(null)

  // `cancelled`, because unlike the pushed [id] detail screens this component
  // stays MOUNTED while `route` changes underneath it -- so a slow fetch for
  // the previously-peeked reg could resolve after a newer one and render its
  // text, with its bookmark state on the bookmark button. Tapping bookmark
  // then saved the wrong document. Dismissing the peek mid-flight hit the same
  // path, since the `!route` early return cleared state without invalidating
  // the request. Worst on the tablet SplitPane, where selectedRoute changes in
  // place and two quick taps in the section rail is all it takes.
  useEffect(() => {
    let cancelled = false
    if (!route) { setData(null); setNotFound(false); setFigures([]); return () => { cancelled = true } }
    const parsed = parsePreviewRoute(route)
    if (!parsed) {
      onClose()
      router.push(route as any)
      return () => { cancelled = true }
    }
    setData(null)
    setNotFound(false)
    setFigures([])
    setLoading(true)
    fetchRegPreview(parsed.kind, parsed.id).then((d) => {
      if (cancelled) return
      if (d) {
        setData(d)
        isBookmarked(d.id).then((b) => { if (!cancelled) setBookmarked(b) })
        if (parsed.kind === 'aim') {
          supabase
            .from('aim_figures')
            .select('id, label, caption, image_url')
            .eq('paragraph_number', d.id)
            .order('sort_order')
            .then(({ data: figRows }) => { if (!cancelled) setFigures(figRows ?? []) })
        }
      } else setNotFound(true)
      setLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route])

  // !authLoading on both gates below: hasPlusAccess is false for everyone
  // until context/auth.tsx's `loading` resolves, and each of these doesn't
  // just refuse -- it CLOSES this preview pane and navigates away. Swallow
  // the tap for that window instead of tearing a real subscriber's preview
  // down and dropping them on a paywall.
  const handleToggleBookmark = async () => {
    if (!data) return
    if (!hasPlusAccess) { if (!authLoading) { onClose(); router.push('/paywall?tier=plus') } return }
    setBookmarked((prev) => !prev) // optimistic
    const next = await toggleBookmark({
      id: data.id,
      itemType: data.kind,
      document_number: data.label,
      title: data.title,
      date_issued: null,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  const handleOpenFolderPicker = () => {
    if (!data) return
    if (!hasPlusAccess) { if (!authLoading) { onClose(); router.push('/paywall?tier=plus') } return }
    setFolderPickerOpen(true)
  }

  return {
    hasPlusAccess, hasProAccess, data, loading, notFound, bookmarked, folderPickerOpen, setFolderPickerOpen,
    figures, viewerFigure, setViewerFigure, confirmTick, confirmLabel, setConfirmLabel, setConfirmTick,
    childRoute, setChildRoute, handleToggleBookmark, handleOpenFolderPicker,
    bodyRef, scrollRef, viewportHeight, setViewportHeight, inDocSearch,
  }
}

interface RegPreviewChromeProps {
  route: string | null
  onClose: () => void
  /** modal: slide-up sheet with scrim + close button (existing RefPacks/
   *  notes/shared-folder behavior). pane: fills its container, no scrim/
   *  close button -- for the persistent iPad-landscape split-view detail
   *  pane, where there's nothing to "close," only something else to select. */
  variant: 'modal' | 'pane'
  /** The search term (if any) that led here -- see useRegPreviewContent's
   *  own comment for why this only ever comes from the top-level caller. */
  highlightQuery?: string
}

function RegPreviewChrome({ route, onClose, variant, highlightQuery }: RegPreviewChromeProps) {
  const { tokens } = useTheme()
  const fs = useFS()
  const c = useRegPreviewContent(route, onClose, highlightQuery)

  const body = (
    <>
      <View style={[styles.header, { borderBottomColor: tokens.bdr }]}>
        <Text style={[styles.headerLabel, { color: tokens.blu, fontSize: fs(13.5) }]} numberOfLines={1}>
          {c.data?.label ?? ' '}
        </Text>
        {c.data && (
          <View style={styles.headerActions}>
            <Pressable onPress={c.handleOpenFolderPicker} hitSlop={10} style={{ padding: 4 }}>
              <Icon name="folder.badge.plus" size={fs(21)} color={c.hasPlusAccess ? tokens.t2 : tokens.t4} />
            </Pressable>
            <Pressable onPress={c.handleToggleBookmark} hitSlop={10} style={{ padding: 4 }}>
              <Icon name={c.bookmarked ? 'bookmark.fill' : 'bookmark'} size={fs(21)} color={c.bookmarked ? tokens.gold : tokens.t2} />
            </Pressable>
          </View>
        )}
        {variant === 'modal' && (
          <Pressable onPress={onClose} hitSlop={10} style={{ padding: 4 }}>
            <Icon name="xmark" size={fs(18)} color={tokens.t3} />
          </Pressable>
        )}
      </View>
      {!!highlightQuery && c.inDocSearch.matchCount > 0 && (
        <View style={[styles.jumpRow, { borderBottomColor: tokens.bdr }]}>
          <Text style={[styles.jumpCount, { color: tokens.t3, fontSize: fs(12.5) }]}>
            "{highlightQuery}" · {c.inDocSearch.matchIdx + 1}/{c.inDocSearch.matchCount}
          </Text>
          <View style={styles.jumpNav}>
            <Pressable hitSlop={12} onPress={c.inDocSearch.goToPrev} style={{ padding: 6 }}>
              <Icon name="chevron.up" size={fs(16)} color={tokens.t2} />
            </Pressable>
            <Pressable hitSlop={12} onPress={c.inDocSearch.goToNext} style={{ padding: 6 }}>
              <Icon name="chevron.down" size={fs(16)} color={tokens.t2} />
            </Pressable>
          </View>
        </View>
      )}
      {c.loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : c.notFound ? (
        <View style={styles.center}>
          <Text style={[styles.notFound, { color: tokens.t3, fontSize: fs(14) }]}>Not found.</Text>
        </View>
      ) : c.data ? (
        <ScrollView
          ref={c.scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={styles.body}
          onLayout={(e) => c.setViewportHeight(e.nativeEvent.layout.height)}
        >
          {!!c.data.title && (
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(16), lineHeight: fs(16) * 1.38 }]}>{stripFarPrefix(c.data.title)}</Text>
          )}
          {/* Real paragraph/table rendering + inline citation hyperlinks --
              same component the full FAR/AIM/P-CG detail screens use.
              figures+onOpenFigure let a "(See FIG x-x-x.)" mention open the
              real image inline (via the nested FigureViewer below).
              onNavigate redirects every other citation link (§ 91.107,
              AC 90-67B, etc.) into a nested Modal RegPreviewPane (see
              childRoute above) instead of navigating away. highlightQuery/
              activeMatch/onMatchCount/scrollRef/viewportHeight are the exact
              same "IN DOC" search contract the full detail screens wire up
              via useInDocSearch -- see the jump-row above and this hook's
              own comment for why the peek gets it for free. */}
          <PlainTextBody
            ref={c.bodyRef}
            text={c.data.body}
            figures={c.figures}
            onOpenFigure={(f) => c.setViewerFigure({ id: f.id, label: f.label ?? '', caption: f.caption, page: 0, image_url: f.image_url })}
            resolveFigureGlobally={c.data.kind === 'aim' ? resolveAimFigureGlobally : undefined}
            hasProAccess={c.hasProAccess}
            onNavigate={c.setChildRoute}
            currentLabel={c.data.label}
            highlightQuery={c.inDocSearch.debounced}
            activeMatch={c.inDocSearch.matchIdx}
            onMatchCount={c.inDocSearch.setMatchCount}
            scrollRef={c.scrollRef}
            viewportHeight={c.viewportHeight}
          />
          {variant === 'modal' && (
            <Pressable
              style={[styles.openBtn, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
              onPress={() => {
                onClose()
                router.push(c.data!.fullRoute as any)
              }}
            >
              <Text style={[styles.openBtnText, { color: tokens.blu, fontSize: fs(13.5) }]}>Open full page</Text>
              <Icon name="arrow.up.right.square" size={fs(14)} color={tokens.blu} />
            </Pressable>
          )}
        </ScrollView>
      ) : (
        variant === 'pane' && (
          <View style={styles.center}>
            <Icon name="doc.text" size={fs(28)} color={tokens.t4} />
            <Text style={[styles.emptyPane, { color: tokens.t4, fontSize: fs(13) }]}>Select a section to read</Text>
          </View>
        )
      )}
      <ConfirmCheck trigger={c.confirmTick} label={c.confirmLabel} />
      {c.data && (
        <FolderPicker
          visible={c.folderPickerOpen}
          itemType={c.data.kind}
          itemId={c.data.id}
          onClose={() => c.setFolderPickerOpen(false)}
          onAdded={(msg) => { c.setConfirmLabel(msg); c.setConfirmTick((t) => t + 1) }}
          acMeta={{ document_number: c.data.label, title: c.data.title, date_issued: null, office: null, subject_series: null }}
        />
      )}
      <FigureViewer figure={c.viewerFigure} onClose={() => c.setViewerFigure(null)} />
      {/* Nested cross-reference peek -- always the Modal variant, on top of
          whichever variant this outer instance is. */}
      <RegPreviewPane route={c.childRoute} onClose={() => c.setChildRoute(null)} />
    </>
  )

  if (variant === 'pane') {
    return <View style={[styles.pane, { backgroundColor: tokens.bg }]}>{body}</View>
  }

  return (
    <Modal visible={route !== null} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: tokens.bg }]}>{body}</View>
    </Modal>
  )
}

export function RegPreviewPane({ route, onClose, highlightQuery }: { route: string | null; onClose: () => void; highlightQuery?: string }) {
  return <RegPreviewChrome route={route} onClose={onClose} variant="modal" highlightQuery={highlightQuery} />
}

// Persistent detail-pane variant -- no Modal, no scrim, no close button,
// fills whatever container it's given (the right-hand pane of SplitPane on
// iPad landscape). `onClose` is only ever invoked internally for the
// "route didn't resolve to a document, navigate instead" fallback and the
// paywall-redirect cases above -- there's no user-facing close affordance.
export function RegPreviewInline({ route, onClose, highlightQuery }: { route: string | null; onClose: () => void; highlightQuery?: string }) {
  return <RegPreviewChrome route={route} onClose={onClose} variant="pane" highlightQuery={highlightQuery} />
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { height: '75%', borderTopLeftRadius: 18, borderTopRightRadius: 18, overflow: 'hidden' },
  pane: { flex: 1 },
  header: {
    // gap (not just justifyContent: 'space-between') -- with headerLabel's
    // flex:1 eating all the slack, headerActions and the close X sat with
    // zero space between them regardless of space-between; BB-075, real
    // device beta report: "add to folder and bookmark icons are too small
    // and too close to the X. Will be mis-hit."
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLabel: { fontWeight: '700', flex: 1, marginRight: 12 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  jumpRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  jumpCount: { fontWeight: '600', flex: 1 },
  jumpNav: { flexDirection: 'row', gap: 6 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8 },
  notFound: {},
  emptyPane: { fontWeight: '500' },
  body: { padding: 16, paddingBottom: 40, gap: 14 },
  // lineHeight NOT set here -- always overridden inline with fs(16) * 1.38
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  title: { fontWeight: '700' },
  bodyText: { lineHeight: 21 },
  openBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, marginTop: 6,
  },
  openBtnText: { fontWeight: '600' },
})
