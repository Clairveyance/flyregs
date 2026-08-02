import { supabase } from '@/lib/supabase'

// Curated, per-paragraph highlight spans for pilot memory aids (AVE-F,
// MEA's lost-comm sense, etc.) -- see sync/migrations_mnemonics.sql for
// why this is a SEPARATE table from dictionary_terms, never a blind
// corpus-wide term match. A mnemonic existing in the Aviation Dictionary
// does not by itself cause any highlighting anywhere; only an explicit,
// text-verified row here does.

export interface MnemonicAnchor {
  mnemonic: string
  letter: string
  anchorText: string
}

export async function fetchMnemonicAnchors(docType: string, docKey: string): Promise<MnemonicAnchor[]> {
  const { data } = await supabase
    .from('reg_mnemonic_anchors')
    .select('mnemonic, letter, anchor_text')
    .eq('doc_type', docType)
    .eq('doc_key', docKey)
  return (data ?? []).map((r: any) => ({ mnemonic: r.mnemonic, letter: r.letter, anchorText: r.anchor_text }))
}

export interface MnemonicSpan {
  text: string
  mnemonic: string | null
}

// Splits `text` into plain/highlighted runs using plain .indexOf() lookups
// against the current text -- if the FAA revises the section and an
// anchor's exact substring no longer appears, that span silently stops
// highlighting (see the anchor table's own comment: fails safe rather
// than pointing at the wrong words). Anchors are authored not to overlap
// each other within one document, so first-match-wins is sufficient; if a
// straddling case is ever found, this is where a stronger position-aware
// merge would go.
export function splitMnemonicSpans(text: string, anchors: MnemonicAnchor[]): MnemonicSpan[] {
  if (anchors.length === 0) return [{ text, mnemonic: null }]
  let spans: MnemonicSpan[] = [{ text, mnemonic: null }]
  for (const anchor of anchors) {
    const next: MnemonicSpan[] = []
    for (const span of spans) {
      if (span.mnemonic) { next.push(span); continue }
      const idx = span.text.indexOf(anchor.anchorText)
      if (idx === -1) { next.push(span); continue }
      const before = span.text.slice(0, idx)
      const match = span.text.slice(idx, idx + anchor.anchorText.length)
      const after = span.text.slice(idx + anchor.anchorText.length)
      if (before) next.push({ text: before, mnemonic: null })
      next.push({ text: match, mnemonic: anchor.mnemonic })
      if (after) next.push({ text: after, mnemonic: null })
    }
    spans = next
  }
  return spans
}
