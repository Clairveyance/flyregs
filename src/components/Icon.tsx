// Web fallback — uses Ionicons (SF Symbols are iOS/Android only)
import { Ionicons } from '@expo/vector-icons'
import type { IconProps } from './Icon.types'
import { View } from 'react-native'
import { AviationHeadset } from './AviationHeadset'
import { PilotWings } from './PilotWings'

// Maps SF Symbol names → Ionicons names
const SF_TO_IONICONS: Record<string, string> = {
  'house': 'home-outline',
  'magnifyingglass': 'search-outline',
  'bookmark': 'bookmark-outline',
  'bookmark.fill': 'bookmark',
  'clock': 'time-outline',
  'square.and.pencil': 'create-outline',
  'printer': 'print-outline',
  'line.3.horizontal': 'menu-outline',
  'arrow.up.arrow.down': 'swap-vertical-outline',
  'xmark': 'close-outline',
  'chevron.right': 'chevron-forward-outline',
  'chevron.left': 'chevron-back-outline',
  'chevron.up': 'chevron-up-outline',
  'chevron.down': 'chevron-down-outline',
  'crown': 'ribbon-outline',
  'crown.fill': 'ribbon',
  'arrow.clockwise': 'refresh-outline',
  'arrow.down.circle': 'cloud-download-outline',
  'arrow.down': 'arrow-down-outline',
  'arrow.up.circle': 'arrow-up-circle-outline',
  'moon.stars': 'moon-outline',
  'clock.badge': 'timer-outline',
  'clock.badge.checkmark': 'timer-outline',
  'questionmark.circle': 'help-circle-outline',
  'envelope': 'mail-outline',
  'ladybug.fill': 'bug',
  'lightbulb.fill': 'bulb',
  'pencil.and.outline': 'create-outline',
  'ellipsis.bubble.fill': 'chatbubble-ellipses',
  'star': 'star-outline',
  'star.fill': 'star',
  'doc.text': 'document-text-outline',
  'doc.plaintext': 'document-outline',
  'bell': 'notifications-outline',
  'bell.badge': 'notifications',
  'folder': 'folder-outline',
  'folder.fill': 'folder',
  'folder.badge.plus': 'folder-open-outline',
  'plus': 'add-outline',
  'trash': 'trash-outline',
  'square.and.arrow.up': 'share-outline',
  'pencil': 'pencil-outline',
  'ellipsis': 'ellipsis-horizontal-outline',
  'checkmark': 'checkmark-outline',
  'checkmark.circle': 'checkmark-circle-outline',
  'checkmark.circle.fill': 'checkmark-circle',
  'xmark.circle.fill': 'close-circle',
  'lock': 'lock-closed-outline',
  'lock.fill': 'lock-closed',
  'faceid': 'finger-print-outline', // Ionicons has no Face ID glyph -- native iOS resolves the real SF Symbol directly, this is web/Android-web-preview only

  'person.crop.circle': 'person-circle-outline',
  'person.2.fill': 'people',
  'icloud': 'cloud-outline',
  'gearshape': 'settings-outline',
  'slider.horizontal.3': 'options-outline',
  'arrow.up.right': 'arrow-up-outline',
  'xmark.circle': 'close-circle-outline',
  'info.circle': 'information-circle-outline',
  'link': 'link-outline',
  'microphone': 'mic-outline',
  'paperplane.fill': 'paper-plane',
  'rectangle.portrait.and.arrow.right': 'log-out-outline',
  'creditcard': 'card-outline',
  'checkmark.seal.fill': 'checkmark-circle',
  'shield.lefthalf.filled': 'shield-checkmark-outline',
  'externaldrive': 'server-outline',
  'hand.thumbsup': 'thumbs-up-outline',
  'sparkles': 'sparkles-outline',
  'airplane': 'airplane-outline',
  'at': 'at-outline',
  'globe': 'globe-outline',
  'arrow.up.right.square': 'open-outline',
  'list.bullet': 'list-outline',
  'camera.fill': 'camera',
  'textformat.size': 'text-outline',
  'highlighter': 'color-wand-outline',
  'photo': 'image-outline',
  'photo.fill': 'image',
  'cloud.fill': 'cloud',
  'sun.max.fill': 'sunny',
  'moon.stars.fill': 'moon',
  'bolt': 'flash-outline',
  'bolt.fill': 'flash',
  'flame.fill': 'flame',
  'exclamationmark.triangle': 'warning-outline',
  'arrow.up.left.and.arrow.down.right': 'expand-outline',
  'eye': 'eye-outline',
  'eye.fill': 'eye',
  'eye.slash': 'eye-off-outline',
  'square.grid.2x2': 'grid-outline',
  'doc.badge.clock': 'document-text-outline',
  'plus.circle.fill': 'add-circle',
  'rosette': 'ribbon-outline',
  'rectangle.stack': 'copy-outline',
  'doc.on.doc': 'copy-outline',
  'arrow.uturn.left': 'arrow-undo-outline',
  'hourglass': 'hourglass-outline',
  'wrench': 'construct-outline',
  'wrench.and.screwdriver': 'construct-outline',
  // Ask FlyRegs (semantic search) -- a real SF Symbol, resolves natively via
  // expo-symbols with no special-casing needed; only the web fallback needs
  // this entry.
  'text.bubble.fill': 'chatbubble-outline',
  // Reg-type identity icons (src/lib/regTypes.ts) — one per content type,
  // reused everywhere that type's chip/badge appears.
  'book.closed.fill': 'book',
  'map.fill': 'map',
  'text.book.closed.fill': 'reader',
  'wrench.and.screwdriver.fill': 'construct',
  // Challenge Coins -- one distinct icon per coin (src/lib/coins.ts)
  'flag.fill': 'flag',
  'flame': 'flame-outline',
  'airplane.circle.fill': 'airplane',
  'graduationcap.fill': 'school',
  'trophy.fill': 'trophy',
  'shield.fill': 'shield',
  // First Blood (won your first Duel) used to reuse 'bolt.fill', the same
  // glyph Duels itself uses everywhere else in the app (ready-room, account,
  // search, challenges) -- confirmed live as real visual confusion, RC:
  // "use a diff icon for this one. the lightning bolt is used elsewhere."
  // A crosshair reads as "scored a hit" without colliding with anything.
  'target': 'locate-outline',
  'exclamationmark.triangle.fill': 'warning',
  'envelope.open.fill': 'mail-open',
  'megaphone.fill': 'megaphone',
  // Reminder type-chip icons (My Aircraft > Reminders quick-select).
  'dot.radiowaves.left.and.right': 'radio-outline',
  // 'gauge' is a REAL, distinct SF Symbol on native (a full circle split by
  // a diagonal line) -- visually nothing like Ionicons' speedometer-outline
  // web fallback, which is what RC actually saw and liked in the Browser
  // preview. Use the literal SF Symbol named 'speedometer' at every call
  // site instead of 'gauge' -- it's Apple's own dial-with-needle glyph, much
  // closer to Ionicons' rendering on both platforms.
  'speedometer': 'speedometer-outline',
  // Aviation Dictionary -- distinct from FAR's 'book.closed.fill' (already
  // in use), a stack of books reads as a broader reference/lookup source
  // than a single regulation volume. See flyregs_decisions.md.
  'books.vertical.fill': 'library',
  // "See X" dictionary cross-reference card (dictionary/[slug].tsx) -- a
  // real SF Symbol on native, needs the explicit web-fallback mapping here.
  'arrow.turn.down.right': 'return-down-forward-outline',
  // Study Mode's "Reveal" button (study.tsx) -- distinct from both
  // 'arrow.uturn.left' (already the Def-first/Term-first toggle on this
  // same screen) and 'arrow.clockwise' (-> refresh-outline, used
  // elsewhere for reloading a deck), so it doesn't collide with either.
  'arrow.triangle.2.circlepath': 'sync-outline',
}

export function Icon({ name, size = 22, color, style }: IconProps) {
  // Drawn, not mapped: Ionicons' headset is a music headphone, and the P/CG
  // needs a pilot's headset (ear cup + boom mic) to read as aviation. Sharing
  // one glyph with Icon.native.tsx also keeps web and device identical --
  // previously the native side silently rendered nothing at all here.
  if (name === 'headset') {
    return (
      <View style={style as object}>
        <AviationHeadset size={size} color={color ?? '#000'} />
      </View>
    )
  }
  // No SF Symbol reads as a pilot-wings badge -- see PilotWings.tsx.
  if (name === 'wings') {
    return (
      <View style={style as object}>
        <PilotWings size={size} color={color ?? '#000'} />
      </View>
    )
  }
  const ionName = (SF_TO_IONICONS[name] ?? 'help-circle-outline') as keyof typeof Ionicons.glyphMap
  return (
    <Ionicons
      name={ionName}
      size={size}
      color={color}
      // @ts-ignore — Ionicons style prop accepts ViewStyle on web
      style={style}
    />
  )
}
