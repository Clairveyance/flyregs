import { Platform, Share } from 'react-native'
import * as Sharing from 'expo-sharing'
import { useAuth } from '@/context/auth'
import { useShareCard } from '@/components/ShareCardCapture'
import { getAvatarUrl, getDisplayName } from '@/lib/avatar'

// Premium feature — every call site should gate on isPremium and route to
// /paywall?tier=premium itself before calling these (kept out of here since
// each screen already owns its own paywall-routing pattern).

export interface ShareableAC {
  document_number: string
  title: string
}

export interface ShareableNote {
  title: string
  body: string
  linked_ac?: string | null
}

function acLine(ac: ShareableAC): string {
  return `AC ${ac.document_number}: ${ac.title}\nhttps://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_${ac.document_number}.pdf`
}

function noteLine(note: ShareableNote): string {
  const ref = note.linked_ac ? ` (AC ${note.linked_ac})` : ''
  return `${note.title || 'Untitled'}${ref}\n${note.body}`
}

// All shares render a branded card (sharer's avatar + name baked into the
// image) via ShareCardProvider. On iOS, RN's own Share.share() can attach
// that local image file (`url`) AND an accompanying text message together in
// one native share sheet — so the recipient gets the nice card AND an actual
// working link back to the document, not just a static picture. This used to
// go through expo-sharing's shareAsync() instead, which only accepts an
// image — there's no url/text field in its native SharingOptions at all, so
// every share silently arrived as a picture with no way to open the real
// document. expo-sharing is kept for Android (not yet shipped): RN's bare
// Share.share() doesn't reliably attach local files there without a
// FileProvider content:// URI, which expo-sharing handles for you.
export function useShareActions() {
  const { session } = useAuth()
  const { capture } = useShareCard()

  const shareAC = async (ac: ShareableAC) => {
    try {
      const uri = await capture({
        avatarUrl: getAvatarUrl(session),
        displayName: getDisplayName(session),
        kind: 'ac',
        documentNumber: `AC ${ac.document_number}`,
        title: ac.title,
      })
      if (Platform.OS === 'ios') {
        await Share.share({ title: `AC ${ac.document_number}`, message: acLine(ac), url: uri })
        return
      }
      if (Platform.OS === 'web' || !(await Sharing.isAvailableAsync())) {
        await Share.share({ title: `AC ${ac.document_number}`, message: acLine(ac) })
        return
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: `AC ${ac.document_number}` })
    } catch {
      // User cancelled or share unavailable
    }
  }

  const shareNote = async (note: ShareableNote) => {
    try {
      const uri = await capture({
        avatarUrl: getAvatarUrl(session),
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
      const items = [
        ...acs.map((ac) => ({ label: ac.document_number, title: ac.title })),
        ...notes.map((n) => ({ label: undefined, title: n.title || 'Untitled' })),
      ]
      const uri = await capture({
        avatarUrl: getAvatarUrl(session),
        displayName: getDisplayName(session),
        kind: 'multi',
        title: `${total} item${total !== 1 ? 's' : ''} shared`,
        items,
      })
      const parts: string[] = []
      if (acs.length) parts.push(acs.map(acLine).join('\n\n'))
      if (notes.length) parts.push(notes.map(noteLine).join('\n\n'))
      const message = parts.join('\n\n')
      if (Platform.OS === 'ios') {
        await Share.share({ message, url: uri })
        return
      }
      if (Platform.OS === 'web' || !(await Sharing.isAvailableAsync())) {
        await Share.share({ message })
        return
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: `${total} items` })
    } catch {}
  }

  return { shareAC, shareNote, shareMany }
}
