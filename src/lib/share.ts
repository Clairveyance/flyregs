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
// image) via ShareCardProvider, then hand the image to the native share
// sheet through expo-sharing — RN's bare Share.share() can't reliably attach
// a local image file on Android, only iOS.
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
      if (Platform.OS === 'web' || !(await Sharing.isAvailableAsync())) {
        const parts: string[] = []
        if (acs.length) parts.push(acs.map(acLine).join('\n\n'))
        if (notes.length) parts.push(notes.map(noteLine).join('\n\n'))
        await Share.share({ message: parts.join('\n\n') })
        return
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: `${total} items` })
    } catch {}
  }

  return { shareAC, shareNote, shareMany }
}
