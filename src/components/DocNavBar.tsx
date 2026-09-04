import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// Thin strip directly under a reg detail screen's OverlayHeader, shown only
// when the user arrived here via a cross-reference jump (MagicLink tap or
// in-doc hyperlink) -- see navBreadcrumb.ts. Confirmed live as a real gap:
// jumping FAR -> AIM -> P/CG a few taps deep left no way back to where you
// started except repeated native back-taps, easy to lose track of. Tapping
// this just calls the same onBack the header's own chevron uses -- the
// native navigation stack already goes to the right place, this is purely
// a visible label for what that native "back" actually returns to.
export function BackToBreadcrumb({ label, onPress }: { label: string; onPress: () => void }) {
  const { tokens } = useTheme()
  const fs = useFS()
  return (
    <Pressable
      style={[styles.wrap, { backgroundColor: tokens.bg2, borderBottomColor: tokens.bdr }]}
      onPress={onPress}
    >
      <Icon name="arrow.uturn.left" size={fs(12)} color={tokens.blu} />
      <Text style={[styles.text, { color: tokens.blu, fontSize: fs(12.5) }]} numberOfLines={1}>
        Back to {label}
      </Text>
    </Pressable>
  )
}

// Fixed strip (sibling of the ScrollView, not inside it) flagging that this
// document has recent revisions, with up/down chevrons to jump between the
// changed paragraphs. RC, real device: "you have the box that says how many
// paragraphs are changed, but the up/down chevrons don't stay available as
// you scroll, so once you go to one, you lose access to the rest and have
// to go back to the top." Every one of FAR/AIM/cfr49/AC's own detail
// screens used to render this INLINE in the ScrollView's own content
// (right after the MagicLink bars), so scrolling past it lost the chevrons
// entirely — same fixed-strip treatment as BackToBreadcrumb above (a
// per-screen render, not a global overlay, so it only ever occupies space
// on a screen that actually has changes to show).
export function ChangedBanner({
  count,
  currentIdx,
  onPrev,
  onNext,
  label,
}: {
  count: number
  currentIdx: number
  onPrev: () => void
  onNext: () => void
  label: string
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  if (count === 0) return null
  return (
    <View style={[styles.changedWrap, { backgroundColor: tokens.bdim, borderBottomColor: tokens.bbdr }]}>
      <Icon name="doc.badge.clock" size={fs(13)} color={tokens.blu} />
      <Text style={[styles.changedText, { color: tokens.blu, fontSize: fs(12.5) }]} numberOfLines={1}>
        {label}
      </Text>
      {count > 1 && (
        <Text style={[styles.changedCount, { color: tokens.t2, fontSize: fs(11.5) }]}>{currentIdx + 1}/{count}</Text>
      )}
      {/* Only meaningful with somewhere to go. At count === 1 both chevrons
          just re-scroll to the one changed paragraph -- two live-looking
          controls that do nothing. This also lets a document type with no
          paragraph machinery at all (P/CG, whose definition is a single
          short block) use this banner purely as an "updated" signal. */}
      {count > 1 && (
        <>
          <Pressable onPress={onPrev} hitSlop={8}>
            <Icon name="chevron.up" size={fs(14)} color={tokens.blu} />
          </Pressable>
          <Pressable onPress={onNext} hitSlop={8}>
            <Icon name="chevron.down" size={fs(14)} color={tokens.blu} />
          </Pressable>
        </>
      )}
    </View>
  )
}

// Shown when a detail screen is rendering a DownloadedAC fallback instead
// of a live fetch (see isDownloadStale's own comment for the full
// reasoning) -- every offline render used to be visually IDENTICAL to a
// live one, with no signal the text on screen was a snapshot rather than
// current. `stale` is only ever true/false on POSITIVE or absent evidence,
// never a guess -- see isDownloadStale in downloads.ts. Always renders
// (unlike ChangedBanner, which hides on count===0) since "you're reading a
// saved copy from a date" is worth saying even when nothing is known to
// have changed since.
export function OfflineCopyBanner({
  downloadedAt,
  stale,
  readOnly = false,
}: {
  downloadedAt: string
  stale: boolean
  /** True when the reader is below Premium. Their saved copies stay fully
   *  readable -- RC, 2026-09-04: "keep it read-only at plus/free, no
   *  deleting" -- but nothing says WHY they can no longer add more, and a
   *  Download button that simply stops working reads as a bug. This says it
   *  once, quietly, on a document they already own.
   *
   *  Deliberately not a paywall push: the content is theirs, they paid for it
   *  while they were Premium, and the cost of keeping it is zero (the bytes
   *  are on their device; our storage holds ONE shared copy of each document
   *  either way). The only thing Premium buys is the egress of saving MORE.
   */
  readOnly?: boolean
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const dateStr = new Date(downloadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const color = stale ? tokens.amb : tokens.t3
  const label = stale
    ? `Offline copy from ${dateStr} — a newer version may be available`
    : readOnly
      ? `Offline copy — saved ${dateStr}. Yours to keep; saving new ones needs Premium.`
      : `Offline copy — saved ${dateStr}`
  return (
    <View style={[styles.changedWrap, { backgroundColor: tokens.bdim, borderBottomColor: tokens.bbdr }]}>
      <Icon name={stale ? 'exclamationmark.triangle.fill' : 'icloud'} size={fs(13)} color={color} />
      <Text style={[styles.changedText, { color, fontSize: fs(12.5) }]} numberOfLines={2}>
        {label}
      </Text>
    </View>
  )
}

// Prev/Next footer for browsing sequentially through a document's own
// natural order (FAR section within a Part, AIM paragraph within a
// chapter) -- independent of the breadcrumb above, which is only about
// cross-reference jumps.
export function PrevNextFooter({
  prevLabel,
  nextLabel,
  onPrev,
  onNext,
}: {
  prevLabel: string | null
  nextLabel: string | null
  onPrev: () => void
  onNext: () => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  // Prev/next document titles can run long and get cut off the same way FAR
  // Part titles do -- same hook/card pair as far/index.tsx's own long-press
  // preview. Self-contained here (one PrevNextFooter instance per document
  // screen, not a repeating list row) rather than threaded from each of the
  // FAR/AIM/AD/LOI screens that render this shared component.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()
  if (!prevLabel && !nextLabel) return null
  return (
    <View style={[styles.footerWrap, { borderTopColor: tokens.bdr, backgroundColor: tokens.bg }]}>
      <Pressable
        style={[styles.footerBtn, !prevLabel && styles.footerBtnDisabled]}
        onPress={() => {
          if (consumeLongPress()) return
          onPrev()
        }}
        onLongPress={(e) => { if (prevLabel) showPreview(prevLabel, e) }}
        onPressOut={hidePreview}
        delayLongPress={350}
        disabled={!prevLabel}
      >
        <Icon name="chevron.left" size={fs(14)} color={prevLabel ? tokens.blu : tokens.t4} />
        <Text style={[styles.footerText, { color: prevLabel ? tokens.t1 : tokens.t4, fontSize: fs(12.5) }]} numberOfLines={1}>
          {prevLabel ?? 'Start'}
        </Text>
      </Pressable>
      <View style={[styles.footerDivider, { backgroundColor: tokens.bdr }]} />
      <Pressable
        style={[styles.footerBtn, styles.footerBtnRight, !nextLabel && styles.footerBtnDisabled]}
        onPress={() => {
          if (consumeLongPress()) return
          onNext()
        }}
        onLongPress={(e) => { if (nextLabel) showPreview(nextLabel, e) }}
        onPressOut={hidePreview}
        delayLongPress={350}
        disabled={!nextLabel}
      >
        <Text style={[styles.footerText, { color: nextLabel ? tokens.t1 : tokens.t4, fontSize: fs(12.5) }]} numberOfLines={1}>
          {nextLabel ?? 'End'}
        </Text>
        <Icon name="chevron.right" size={fs(14)} color={nextLabel ? tokens.blu : tokens.t4} />
      </Pressable>
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

// Prev/Next control for jumping between the embedded tables/figures ("T&F")
// inside the CURRENT document's own body text -- independent of both the
// breadcrumb above (cross-reference jumps) and PrevNextFooter below (moving
// to a different document/section entirely). Rendered by the parent screen
// directly above its own PrevNextFooter, stacking "T&F navigation" on top
// of "document navigation" at the very bottom of the page. RC, real
// device: this used to render inline right after every table in the body --
// "they're good, but right now they're in the middle of the screen. Place
// them down near the bottom... they would only show when a T&F has already
// been selected to view." PlainTextBody now just reports which table (if
// any) counts as "currently viewed" via its onActiveTableChange callback;
// this component only draws the bar, so all 4 screens that render tables
// (FAR/AIM/AD/LOI) get the identical bar instead of 4 hand-rolled copies.
export function TableNavBar({
  ord,
  total,
  onPrev,
  onNext,
}: {
  /** 0-based index of the currently-viewed table among all tables in this
   * doc -- shown to the reader as `ord + 1` ("2 of 3"). */
  ord: number
  total: number
  /** Either may be null/undefined at an end -- same disabled-chevron
   * treatment as PrevNextFooter's own Start/End state. */
  onPrev: (() => void) | null
  onNext: (() => void) | null
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  return (
    <View style={[styles.tableNavWrap, { borderTopColor: tokens.bdr, backgroundColor: tokens.bg2 }]}>
      <Pressable
        hitSlop={11}
        style={[styles.tableNavBtn, !onPrev && styles.tableNavBtnDisabled]}
        onPress={() => onPrev?.()}
        disabled={!onPrev}
      >
        <Icon name="chevron.left" size={fs(11)} color={onPrev ? tokens.blu : tokens.t4} />
        <Text style={{ color: onPrev ? tokens.blu : tokens.t4, fontSize: fs(12), fontWeight: '600' }}>Prev Table</Text>
      </Pressable>
      <Text style={{ color: tokens.t4, fontSize: fs(11.5) }}>{ord + 1} of {total}</Text>
      <Pressable
        hitSlop={11}
        style={[styles.tableNavBtn, !onNext && styles.tableNavBtnDisabled]}
        onPress={() => onNext?.()}
        disabled={!onNext}
      >
        <Text style={{ color: onNext ? tokens.blu : tokens.t4, fontSize: fs(12), fontWeight: '600' }}>Next Table</Text>
        <Icon name="chevron.right" size={fs(11)} color={onNext ? tokens.blu : tokens.t4} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { fontWeight: '600', flex: 1 },

  changedWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  changedText: { fontWeight: '700', flex: 1 },
  changedCount: { fontWeight: '500' },

  footerWrap: {
    flexDirection: 'row', alignItems: 'stretch', borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, justifyContent: 'flex-start',
    paddingHorizontal: 14, paddingVertical: 12,
  },
  footerBtnRight: { justifyContent: 'flex-end' },
  footerBtnDisabled: { opacity: 0.5 },
  footerText: { fontWeight: '600', flexShrink: 1 },
  footerDivider: { width: StyleSheet.hairlineWidth },

  tableNavWrap: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth,
  },
  tableNavBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 4 },
  tableNavBtnDisabled: { opacity: 0.4 },
})
