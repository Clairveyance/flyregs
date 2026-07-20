import { Platform, Share } from 'react-native'
import * as Sharing from 'expo-sharing'
import { useAuth } from '@/context/auth'
import { useShareCard } from '@/components/ShareCardCapture'
import { resolveAvatarUrl, resolveAvatarPresetId, getDisplayName } from '@/lib/avatar'
import { buildACShareLink } from '@/lib/acShare'

// Premium feature — every call site should gate on isPremium and route to
// /paywall?tier=premium itself before calling these (kept out of here since
// each screen already owns its own paywall-routing pattern).

export interface ShareableAC {
  id: string
  document_number: string
  title: string
  /** Present when sharing an existing highlight bookmark -- carries the
   * passage through the same way "Share Passage" does, so the recipient's
   * copy both jumps to AND highlights that exact block, not just the AC
   * generally. Use highlightSnippet() from lib/acShare to build this from a
   * block's full text. */
  highlightSnippet?: string
}

export interface ShareableNote {
  title: string
  body: string
  linked_ac?: string | null
}

// Just the branded flyregs.com/ac/ link, no title/doc-number prefix -- the
// share card image already shows that, so repeating it as text was the
// "too much stuff in the message" the sender and recipient both have to
// read past to find the actual link.
function acLine(ac: ShareableAC): string {
  return buildACShareLink(ac, ac.highlightSnippet)
}

function noteLine(note: ShareableNote): string {
  const ref = note.linked_ac ? ` (AC ${note.linked_ac})` : ''
  return `${note.title || 'Untitled'}${ref}\n${note.body}`
}

// AC/folder shares are plain text (just the link) -- no branded card image
// attached. Two real problems came from attaching one: (1) it's what made
// the message read as "too much stuff" next to a picture that just repeats
// the AC title/number already in the link's own destination page, and (2)
// AirDrop (and some other share-sheet targets) only transfers the attached
// FILE, silently dropping the accompanying text entirely -- so an AirDropped
// share arrived as a bare image with no link at all, landing in Photos
// instead of opening the app. A pure text share has nothing to lose there.
// shareNote (a standalone note, no link to lose) keeps the branded card.
export function useShareActions() {
  const { session, avatarOverride } = useAuth()
  const { capture } = useShareCard()

  const shareAC = async (ac: ShareableAC) => {
    try {
      await Share.share({ title: `AC ${ac.document_number}`, message: acLine(ac) })
    } catch {
      // User cancelled or share unavailable
    }
  }

  const shareNote = async (note: ShareableNote) => {
    try {
      const uri = await capture({
        avatarUrl: resolveAvatarUrl(avatarOverride, session),
        avatarPreset: resolveAvatarPresetId(avatarOverride, session),
        displayName: getDisplayName(session),
        kind: 'note',
        title: note.title || 'Untitled',
        subtitle: note.body,
      })
      if (Platform.OS === 'ios') {
        await Share.share({ title: note.title || 'Note', message: noteLine(note), url: uri })
        return
      }
      if (Platform.OS === 'web' || !(await Sharing.isAvailableAsync())) {
        await Share.share({ title: note.title || 'Note', message: noteLine(note) })
        return
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: note.title || 'Note' })
    } catch {}
  }

  const shareMany = async (acs: ShareableAC[], notes: ShareableNote[] = []) => {
    const total = acs.length + notes.length
    if (!total) return
    try {
      const parts: string[] = []
      if (acs.length) parts.push(acs.map(acLine).join('\n\n'))
      if (notes.length) parts.push(notes.map(noteLine).join('\n\n'))
      const message = parts.join('\n\n')
      await Share.share({ message })
    } catch {}
  }

  return { shareAC, shareNote, shareMany }
}
