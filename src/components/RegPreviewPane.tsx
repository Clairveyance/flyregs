import { useEffect, useState } from 'react'
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
import { PlainTextBody } from '@/components/PlainTextBody'
import { FigureViewer } from '@/components/FigureViewer'
import { stripFarPrefix } from '@/lib/titleFormat'
import type { AcFigure } from '@/types'

interface PreviewFigure {
  id: string
  label: string | null
  caption: string | null
  image_url: string
}

// Generic "stay where you are" reg preview -- same idea as notes.tsx's AC
// bottom pane (openAcPane), generalized to any single-document route
// (AC/FAR/AIM/P-CG/AD) so callers like Ref Packets can show cross-
// referenced content inline instead of navigating away. Deliberately a
// simpler fixed slide-up sheet rather than notes.tsx's full drag-gesture
// pane -- that one's PanResponder/spring machinery is tailored to a single
// screen; this is meant to drop into any screen with just a `route` prop.
//
// route: a linkifyText/linkifyReferences route string, or null to hide.
// Routes that don't resolve to a single document (bare "/aim", "/far/part/61")
// fall through to a normal router.push instead of opening the sheet.
//
// Bookmark + "add to folder" actions live in the header -- this is what
// makes "read it, highlight it, save it to a folder I created, then close
// that page and be right back" (the RefPacks redesign ask) actually work:
// without these, the only way to save something found here was to first
// navigate to its full page, defeating "stay in the pack." Character-level
// highlighting is a separate, native-module-dependent feature (still
// pending, see flyregs_pending.md) -- saving the whole document is the
// available "keep this for later" action today.
export function RegPreviewPane({ route, onClose }: { route: string | null; onClose: () => void }) {
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess } = useAuth()
  const [data, setData] = useState<RegPreviewData | null>(null)
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
  // Tapping a citation INSIDE this preview opens ANOTHER RegPreviewPane on
  // top of it (this component rendering itself, recursively) instead of
  // navigating away -- confirmed live as a real bug/ask: "inside that reg
  // are hyperlinks to other regs and T&Fs... if you click on those, the app
  // needs to open another half screen over that half screen... this ENTIRE
  // process MUST take place in and STAY inside the RP." Closing the nested
  // sheet just clears this state, which reveals the still-mounted parent
  // sheet underneath -- unlimited depth for free, no stack data structure
  // needed since each level owns its own childRoute.
  const [childRoute, setChildRoute] = useState<string | null>(null)

  useEffect(() => {
    if (!route) { setData(null); setNotFound(false); setFigures([]); return }
    const parsed = parsePreviewRoute(route)
    if (!parsed) {
      onClose()
      router.push(route as any)
      return
    }
    setData(null)
    setNotFound(false)
    setFigures([])
    setLoading(true)
    fetchRegPreview(parsed.kind, parsed.id).then((d) => {
      if (d) {
        setData(d)
        isBookmarked(d.id).then(setBookmarked)
        if (parsed.kind === 'aim') {
          supabase
            .from('aim_figures')
            .select('id, label, caption, image_url')
            .eq('paragraph_number', d.id)
            .order('sort_order')
            .then(({ data: figRows }) => setFigures(figRows ?? []))
        }
      } else setNotFound(true)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route])

  const handleToggleBookmark = async () => {
    if (!data) return
    if (!hasPlusAccess) { onClose(); router.push('/paywall'); return }
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
    if (!hasPlusAccess) { onClose(); router.push('/paywall'); return }
    setFolderPickerOpen(true)
  }

  return (
    <Modal visible={route !== null} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: tokens.bg }]}>
        <View style={[styles.header, { borderBottomColor: tokens.bdr }]}>
          <Text style={[styles.headerLabel, { color: tokens.blu, fontSize: fs(13.5) }]} numberOfLines={1}>
            {data?.label ?? ' '}
          </Text>
          {data && (
            <View style={styles.headerActions}>
              <Pressable onPress={handleOpenFolderPicker} hitSlop={10} style={{ padding: 4 }}>
                <Icon name="folder.badge.plus" size={18} color={hasPlusAccess ? tokens.t2 : tokens.t4} />
              </Pressable>
              <Pressable onPress={handleToggleBookmark} hitSlop={10} style={{ padding: 4 }}>
                <Icon name={bookmarked ? 'bookmark.fill' : 'bookmark'} size={18} color={bookmarked ? tokens.gold : tokens.t2} />
              </Pressable>
            </View>
          )}
          <Pressable onPress={onClose} hitSlop={10} style={{ padding: 4 }}>
            <Icon name="xmark" size={18} color={tokens.t3} />
          </Pressable>
        </View>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={tokens.blu} />
          </View>
        ) : notFound ? (
          <View style={styles.center}>
            <Text style={[styles.notFound, { color: tokens.t3, fontSize: fs(14) }]}>Not found.</Text>
          </View>
        ) : data ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body}>
            {!!data.title && (
              <Text style={[styles.title, { color: tokens.t1, fontSize: fs(16) }]}>{stripFarPrefix(data.title)}</Text>
            )}
            {/* Real paragraph/table rendering + inline citation hyperlinks --
                same component the full FAR/AIM/P-CG detail screens use.
                Previously a bare <Text>, which dumped AIM's " | "-delimited
                table rows as one unreadable run-on line and left every
                citation/T&F mention as dead plain text -- confirmed live
                on AIM 2-3-3's own runway-marking tables. figures+onOpenFigure
                let a "(See FIG x-x-x.)" mention open the real image inline
                (via the nested FigureViewer below) instead of silently
                falling through to PlainTextBody's route-guess fallback --
                confirmed live as a serious bug: tapping FIG 1-1-6 inside a
                RefPack's AIM 1-1-9 preview did nothing visible AND pushed
                the background router to the wrong page (/aim/1-1-6, an
                unrelated paragraph) out from under the still-open modal.
                onNavigate redirects every other citation link (§ 91.107,
                AC 90-67B, etc.) into a NESTED RegPreviewPane (see
                childRoute below) instead of navigating away -- the whole
                point of a Ref Packet is staying inside it. */}
            <PlainTextBody
              text={data.body}
              figures={figures}
              onOpenFigure={(f) => setViewerFigure({ id: f.id, label: f.label ?? '', caption: f.caption, page: 0, image_url: f.image_url })}
              resolveFigureGlobally={data.kind === 'aim' ? resolveAimFigureGlobally : undefined}
              onNavigate={setChildRoute}
              currentLabel={data.label}
            />
            <Pressable
              style={[styles.openBtn, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
              onPress={() => {
                onClose()
                router.push(data.fullRoute as any)
              }}
            >
              <Text style={[styles.openBtnText, { color: tokens.blu, fontSize: fs(13.5) }]}>Open full page</Text>
              <Icon name="arrow.up.right.square" size={14} color={tokens.blu} />
            </Pressable>
          </ScrollView>
        ) : null}
        <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
      </View>
      {data && (
        <FolderPicker
          visible={folderPickerOpen}
          itemType={data.kind}
          itemId={data.id}
          onClose={() => setFolderPickerOpen(false)}
          onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
          acMeta={{ document_number: data.label, title: data.title, date_issued: null, office: null, subject_series: null }}
        />
      )}
      <FigureViewer figure={viewerFigure} onClose={() => setViewerFigure(null)} />
      {/* Self-recursive nesting -- see childRoute's own comment. Rendered as
          a sibling Modal INSIDE this one, not outside it, so closing the
          outer pane (its `route` prop going null) unmounts this whole tree,
          nested children included, with no separate cleanup needed. */}
      <RegPreviewPane route={childRoute} onClose={() => setChildRoute(null)} />
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { height: '75%', borderTopLeftRadius: 18, borderTopRightRadius: 18, overflow: 'hidden' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLabel: { fontWeight: '700', flex: 1, marginRight: 12 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  notFound: {},
  body: { padding: 16, paddingBottom: 40, gap: 14 },
  title: { fontWeight: '700', lineHeight: 22 },
  bodyText: { lineHeight: 21 },
  openBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, marginTop: 6,
  },
  openBtnText: { fontWeight: '600' },
})
