import { Platform, Share } from 'react-native'
import * as Sharing from 'expo-sharing'
import { useAuth } from '@/context/auth'
import { useShareCard } from '@/components/ShareCardCapture'
import { resolveAvatarUrl, resolveAvatarPresetId, getDisplayName } from '@/lib/avatar'
import { buildACShareLink } from '@/lib/acShare'
import { buildRegShareLink, RegShareType } from '@/lib/regShare'

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

// FAR/AIM/P-CG/AD/LOI equivalent of ShareableAC -- Saved/Recents/Folder's
// own Share buttons silently no-op'd for any bookmark that wasn't itemType
// 'ac' even though buildRegShareLink/flyregs.com's generic reg/ page
// already works (each type's own detail screen has used it successfully
// since #55). `label` is the short display id shown in the message/link
// (e.g. "§ 91.3", "3-3-3", "SIGMET", "2018-02-04" -- same value stored as
// a bookmark's own document_number field).
export interface ShareableReg {
  type: RegShareType
  id: string
  label: string
  title?: string
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

function regLine(item: ShareableReg): string {
  // LOI's stored `title` (Saved/Recents/Folder rows) is either a raw,
  // often mid-clause-truncated OCR summary sentence or -- on the majority
  // of the corpus, where no summary exists -- just a repeat of the same
  // humanized title already used as `label`. Neither is a useful one-line
  // description the way every other RegShareType's title genuinely is
  // (a real FAR/AC/AIM section title). Omit it for LOI specifically and
  // let the website's own typeName fallback apply ("Legal Interpretation")
  // -- same fix as loi/[slug].tsx's own direct Share button, centralized
  // here so every bulk/Saved/Folder/Recents share of an LOI gets it too.
  const title = item.type === 'loi' ? undefined : item.title
  return buildRegShareLink(item.type, item.id, item.label, title)
}

// AC/folder shares are plain text (just the link) -- no branded card image
// attached. Two real problems came from attaching one: (1) it's what made
// the message read as "too much stuff" next to a picture that just repeats
// the AC title/number already in the link's own destination page, and (2)
// AirDrop (and some other share-sheet targets) only transfers the attached
// FILE, silently dropping the accompanying text entirely -- so an AirDropped
// share arrived as a bare image with no link at all, landing in Photos
// instead of opening the app. A pure text share has nothing to lose there.
// shareNote used to keep the branded card here, reasoned as "no link to
// lose" -- that reasoning was wrong: a note's BODY is the actual content,
// and the branded card only bakes in a 2-line truncated preview of it
// (ShareCardCapture.tsx's subtitle, numberOfLines={2}). The exact same
// AirDrop failure this comment already documents would leave the recipient
// with a permanently-truncated image and no way to see the rest of the
// note. Not live-tested (iOS-only, no device/simulator access in this
// environment) -- fixed on the strength of this file's own already-proven
// identical failure mode, matching shareAC/shareReg's resolution rather
// than guessing at a new one.
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
        // Text-only, no `url: uri` -- see the header comment above for why
        // (a note's full body must never be at risk of silently vanishing
        // behind AirDrop's image-only-survives quirk).
        await Share.share({ title: note.title || 'Note', message: noteLine(note) })
        return
      }
      if (Platform.OS === 'web' || !(await Sharing.isAvailableAsync())) {
        await Share.share({ title: note.title || 'Note', message: noteLine(note) })
        return
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: note.title || 'Note' })
    } catch {}
  }

  const shareReg = async (item: ShareableReg) => {
    try {
      await Share.share({ title: item.label, message: regLine(item) })
    } catch {
      // User cancelled or share unavailable
    }
  }

  const shareMany = async (acs: ShareableAC[], notes: ShareableNote[] = [], regs: ShareableReg[] = []) => {
    const total = acs.length + notes.length + regs.length
    if (!total) return
    try {
      const parts: string[] = []
      if (acs.length) parts.push(acs.map(acLine).join('\n\n'))
      if (regs.length) parts.push(regs.map(regLine).join('\n\n'))
      if (notes.length) parts.push(notes.map(noteLine).join('\n\n'))
      const message = parts.join('\n\n')
      await Share.share({ message })
    } catch {}
  }

  return { shareAC, shareNote, shareReg, shareMany }
}
