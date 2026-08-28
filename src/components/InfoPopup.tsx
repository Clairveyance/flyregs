import { useEffect, useRef, useState } from 'react'
import { Modal, View, Text, Pressable, StyleSheet, ScrollView, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { LinearGradient } from 'expo-linear-gradient'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'

const SEEN_KEY_PREFIX = '@flyregs/info-seen/'

// RC, real device: "rather than have the paragraphs on screen all the
// time, we need to just make these info icons bigger and active, so
// tapping them opens a popup dialog box to read. then tap to close... if
// something is important to share, we can force it once (auto popup CTA
// first time opened with an 'i understand' button - so we're clear of
// liability). then the info icon stays so they can always ref it anytime."
//
// Two modes in one component rather than two separate ones, since the
// force-once case is just "the same popup, shown automatically the first
// time, with a stricter dismiss" -- not a different UI.
interface Props {
  /** Stable key for this specific piece of content, used to remember
   * whether a forceOnce popup has already been acknowledged. Must be
   * unique per distinct explanation, not per screen (e.g.
   * 'my-aircraft-equipment-disclaimer', not 'my-aircraft-info'). */
  id: string
  title: string
  /** A single paragraph, or a list of bullet points for anything with more
   * than one distinct idea -- a wall of run-on prose is harder to scan in
   * a small popup than the same content broken into bullets (RC,
   * 2026-08-05, re: My Fleet's intro popup). A bullet can optionally carry
   * its own color, for text that's explaining what a color means (e.g.
   * "green = on track") -- plain string bullets stay the default body
   * color. `indent` nests a bullet under the one above it (smaller dash
   * bullet, extra left padding) -- for a header bullet ("the ring means X")
   * followed by that thing's own colored values, so the grouping reads
   * visually instead of just being a flat run of same-weight bullets. */
  body: string | Array<string | { text: string; color: string; indent?: boolean }>
  /** Rendered below the body text -- for explaining a color/shape convention
   * with the ACTUAL widget (a real ring, a real bold number) instead of
   * describing it in words. RC, My Fleet's ring/number legend: "I want the
   * actual visual 'ring' and the actual big, bold, colored number... the
   * whole point is that the user sees the actual 'icon' representation of
   * these inside this info box, in the same way they're presented on
   * screen." Plain text bullets can't do that; arbitrary content can. */
  footer?: React.ReactNode
  /** If true, auto-opens once (per device) the first time this component
   * mounts, and that first showing can only be dismissed via "I
   * Understand" -- not tap-outside or the X. Every showing after that
   * (including this same one, once acknowledged) behaves like a normal
   * tap-to-open/tap-to-close popup. Use for text with real liability
   * weight; leave false for ordinary explanatory text. */
  forceOnce?: boolean
  iconSize?: number
}

export function InfoPopup({ id, title, body, footer, forceOnce = false, iconSize }: Props) {
  const { tokens } = useTheme()
  const fs = useFS()
  const [visible, setVisible] = useState(false)
  const [forcing, setForcing] = useState(false)
  // RC, real device (13 mini), re: My Aircraft's ring/AD-status legend
  // footer: "the box doesn't show the information at the bottom... needs
  // to be made much more adjustable and scrollable." The ScrollView below
  // already scrolls (confirmed live) -- what's actually missing is any
  // SIGNAL that it does. The last visible line before the cutoff reads as
  // a complete sentence, so there's no visual cue more content follows,
  // and a plain content-fills-the-card popup gives no reason to expect a
  // long popup would need scrolling at all. A bottom fade is the
  // standard, low-risk way to signal "there's more" without touching the
  // scroll mechanism itself (which isn't broken) -- shown only while
  // content genuinely overflows and the user hasn't scrolled to the end.
  const [canScrollMore, setCanScrollMore] = useState(false)

  useEffect(() => {
    if (!forceOnce) return
    let cancelled = false
    AsyncStorage.getItem(SEEN_KEY_PREFIX + id).then((seen) => {
      if (!cancelled && !seen) {
        setForcing(true)
        setVisible(true)
      }
    })
    return () => { cancelled = true }
  }, [forceOnce, id])

  // RC, real device: "this is popping up multiple times. stop that from
  // happening." (aircraft-model-vs-type, re-shown across separate edit
  // sessions on the same/different aircraft). The write below used to be
  // fire-and-forget -- setForcing/setVisible flipped the popup closed
  // immediately, without waiting for the AsyncStorage write to actually
  // land. my-aircraft/[id].tsx is a dynamic route: navigating between two
  // different aircraft (or backgrounding/relaunching the app) remounts
  // this component fresh, which re-reads AsyncStorage on mount (the
  // effect above) -- if that read ever raced ahead of the PREVIOUS
  // session's still-in-flight write, the flag would read as unset and
  // force the popup again, even though the user had already dismissed it.
  // Awaiting the write removes that race outright: dismissal can't
  // complete until the flag is actually persisted.
  const acknowledge = async () => {
    await AsyncStorage.setItem(SEEN_KEY_PREFIX + id, '1')
    // Durable, server-side proof of acknowledgment -- the AsyncStorage flag
    // above only proves this device saw it, which is worthless if the
    // device is lost, reset, or the app is reinstalled. RC: "by them
    // clicking 'I understand'... can we log that acceptance somehow? for
    // legal/liability reasons?" Every forceOnce popup gets this for free
    // (see this component's own doc comment: forceOnce is reserved for
    // "text with real liability weight" already), not just the one that
    // prompted the ask. Best-effort -- a logged-out session or a transient
    // network failure shouldn't block dismissing the dialog the user just
    // read and agreed to.
    supabase.auth.getUser().then(({ data }) => {
      const userId = data.user?.id
      if (!userId) return
      supabase.from('disclaimer_acknowledgments').upsert(
        { user_id: userId, disclaimer_id: id, acknowledged_at: new Date().toISOString() },
        { onConflict: 'user_id,disclaimer_id' },
      )
    })
    setForcing(false)
    setVisible(false)
  }

  const close = () => {
    if (forcing) return // forced first showing only closes via "I Understand"
    setVisible(false)
  }

  // A fixed few px of slack -- onScroll's contentOffset can land a hair
  // short of the true end (rounding, momentum) even when the user has
  // genuinely reached the bottom, which would otherwise leave the fade
  // shown forever over content there's nothing left to reveal.
  const AT_BOTTOM_SLACK = 4
  const containerHeightRef = useRef(0)
  const contentHeightRef = useRef(0)
  const recomputeCanScrollMore = (scrollY: number) => {
    setCanScrollMore(contentHeightRef.current - containerHeightRef.current - scrollY > AT_BOTTOM_SLACK)
  }
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    recomputeCanScrollMore(e.nativeEvent.contentOffset.y)
  }
  const onContentSizeChange = (_w: number, h: number) => {
    contentHeightRef.current = h
    recomputeCanScrollMore(0)
  }
  const onScrollBodyLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
    containerHeightRef.current = e.nativeEvent.layout.height
    recomputeCanScrollMore(0)
  }

  return (
    <>
      <Pressable onPress={() => setVisible(true)} hitSlop={10} style={styles.trigger}>
        <Icon name="info.circle" size={iconSize ?? fs(18)} color={tokens.t3} />
      </Pressable>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.backdrop} onPress={close}>
          {/* RC, real device (13 mini): "this CTA is still way too big for
              the screen." The card had no height cap and nothing inside it
              scrolled -- a popup with a long body (bullets + a footer
              legend widget) simply rendered taller than the screen and
              overflowed both edges equally (backdrop centers it). Fixed
              structurally rather than by trimming copy: this content
              routinely carries real liability weight (forceOnce is
              reserved for exactly that, per this component's own doc
              comment above) and cutting it down to fit one specific
              screen risks quietly losing something that matters. Header
              and the "I Understand" button now stay pinned outside the
              scroll area -- the button especially can't be allowed to
              scroll out of reach on a forceOnce popup, since tap-outside/X
              are both disabled until it's pressed. maxHeight is a fraction
              of the SCREEN, not the card's own natural content height, so
              this only ever engages (and only ever scrolls) when content
              genuinely doesn't fit -- a short popup still renders exactly
              as before. */}
          <Pressable style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.headerRow}>
              <Icon name="info.circle" size={fs(20)} color={tokens.blu} />
              <Text style={[styles.title, { color: tokens.t1, fontSize: fs(16) }]}>{title}</Text>
              {!forcing && (
                <Pressable onPress={close} hitSlop={10}>
                  <Icon name="xmark" size={fs(18)} color={tokens.t3} />
                </Pressable>
              )}
            </View>
            <View style={styles.scrollWrap}>
              <ScrollView
                style={styles.scrollBody}
                contentContainerStyle={styles.scrollBodyContent}
                showsVerticalScrollIndicator={false}
                onLayout={onScrollBodyLayout}
                onContentSizeChange={onContentSizeChange}
                onScroll={onScroll}
                scrollEventThrottle={16}
              >
                {Array.isArray(body) ? (
                  <View style={styles.bulletList}>
                    {body.map((line, i) => {
                      const text = typeof line === 'string' ? line : line.text
                      const color = typeof line === 'string' ? tokens.t2 : line.color
                      const indent = typeof line !== 'string' && line.indent
                      return (
                        <View key={i} style={[styles.bulletRow, indent && styles.bulletRowIndent]}>
                          <Text style={[styles.bulletDot, { color: indent ? color : tokens.t3, fontSize: fs(indent ? 13 : 14.5), lineHeight: fs(indent ? 13 : 14.5) * 1.45 }]}>
                            {indent ? '–' : '•'}
                          </Text>
                          <Text style={[styles.body, styles.bulletText, { color, fontSize: fs(indent ? 13.5 : 14.5), lineHeight: fs(indent ? 13.5 : 14.5) * 1.45 }]}>{text}</Text>
                        </View>
                      )
                    })}
                  </View>
                ) : (
                  <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5), lineHeight: fs(14.5) * 1.45 }]}>{body}</Text>
                )}
                {footer}
              </ScrollView>
              {canScrollMore && (
                <LinearGradient
                  pointerEvents="none"
                  colors={['transparent', tokens.bg2]}
                  style={styles.scrollFade}
                />
              )}
            </View>
            {forcing && (
              <Pressable style={[styles.understandBtn, { backgroundColor: tokens.blu }]} onPress={acknowledge}>
                <Text style={[styles.understandText, { fontSize: fs(14.5) }]}>I Understand</Text>
              </Pressable>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  trigger: { padding: 2 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    // Fraction of the SCREEN (backdrop is flex:1, full-height), not of the
    // card's own content -- a short popup never touches this and renders
    // exactly as before; only a popup whose content is genuinely taller
    // than 85% of the screen ever engages the scroll below.
    maxHeight: '85%',
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontWeight: '700', flex: 1 },
  // flexShrink (not flex/flexGrow) -- takes its natural content height when
  // there's room (a short popup doesn't stretch to fill empty space), but
  // is allowed to shrink below that -- which is what makes it scroll
  // internally -- once headerRow + this + the pinned button together would
  // exceed the card's own maxHeight above. Moved here (was on the
  // ScrollView itself) now that the ScrollView has scrollWrap as its own
  // parent -- the wrapper is what needs to participate in the card's flex
  // layout; the ScrollView inside it just fills whatever height the
  // wrapper resolves to.
  scrollWrap: { flexShrink: 1 },
  scrollBody: {},
  scrollBodyContent: { gap: 14 },
  // Bottom-edge fade signaling more content below -- only rendered while
  // canScrollMore is true (see its own comment). height is a fixed value
  // rather than a percentage: it only needs to be tall enough to read as
  // a fade, not scale with the card's own size.
  scrollFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 28 },
  // lineHeight NOT set here -- always overridden inline with fs(size) * 1.45
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  body: {},
  bulletList: {},
  bulletRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  // Tighter to the row above (its header bullet) than a fresh top-level
  // bullet would be, plus left padding so it visually nests underneath --
  // see the `indent` doc comment on Props.body above.
  bulletRowIndent: { marginTop: 4, marginLeft: 16 },
  // lineHeight NOT set here -- always overridden inline with fs(size) * 1.45
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  bulletDot: {},
  bulletText: { flex: 1 },
  understandBtn: {
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  understandText: { color: '#fff', fontWeight: '600' },
})
