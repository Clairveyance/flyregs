// Web fallback — uses Ionicons (SF Symbols are iOS/Android only)
import { Ionicons } from '@expo/vector-icons'
import type { IconProps } from './Icon.types'
import { PcgGlyph } from './PcgGlyph'

// Maps SF Symbol names → Ionicons names
const SF_TO_IONICONS: Record<string, string> = {
  'house': 'home-outline',
  'magnifyingglass': 'search-outline',
  'bookmark': 'bookmark-outline',
  'bookmark.fill': 'bookmark',
  'clock': 'time-outline',
  'square.and.pencil': 'create-outline',
  'line.3.horizontal': 'menu-outline',
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
  'arrow.uturn.left': 'arrow-undo-outline',
  'hourglass': 'hourglass-outline',
  'wrench': 'construct-outline',
  'wrench.and.screwdriver': 'construct-outline',
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
  'exclamationmark.triangle.fill': 'warning',
  'envelope.open.fill': 'mail-open',
  'megaphone.fill': 'megaphone',
}

export function Icon({ name, size = 22, color, style }: IconProps) {
  if (name === 'pcg.az') {
    return <PcgGlyph size={size} color={color} />
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
