// Splits one long, unbroken paragraph into a few shorter visual chunks at
// natural sentence boundaries — a pure DISPLAY transform, not a data
// change (the underlying stored text is untouched; this only decides how
// many separate <Text> blocks it renders as). Confirmed live as a direct,
// explicit request: a long AC paragraph read as one dense wall on a
// narrow phone screen even though the source itself has no real
// paragraph break there — "maybe if, after everything is parsed and
// formatted to reflect the real docs, we could then add another 'polish'
// pass for ourselves that would simply create a bit of breathing room in
// long chunks of text... finding the natural breaks at the end of some of
// the sentences and asking the system to wrap the next sentence onto a
// new line." Applied wherever a single block of body prose renders,
// FAR/AIM/P-CG (PlainTextBody) and AC (ACBody) alike, so long paragraphs
// look and read the same way everywhere in the app.
//
// Sentence-boundary detection is a light heuristic (". "/"? "/"! "
// followed by a capital letter or the end of the string), not a real NLP
// sentence splitter — it will occasionally misfire on an abbreviation
// ("e.g.", "No.", section numbers like "8.2.1"). That's an acceptable
// trade-off here specifically because this never touches stored data: a
// slightly early or late visual break is a minor cosmetic imperfection,
// not corrupted or lost content.

const TARGET_CHUNK_LENGTH = 220

const SENTENCE_BOUNDARY_RE = /(?<=[.!?])\s+(?=[A-Z0-9"“(])/

export function softWrapParagraph(text: string): string[] {
  const trimmed = text.trim()

  // RC, repeatedly: "ALL big chunky paragraphs, ANYWHERE in this entire app
  // corpus, must be spaced and formatted well" -- and kept finding more
  // every time he looked. Root cause, confirmed on the mnemonic SHARPTT
  // (302 chars, three real sentences, rendered as one dense block): a
  // MIN_LENGTH_TO_SPLIT=380 gate rejected this text before the sentence
  // splitter ever got a chance to run, even though it plainly reads as
  // three separate thoughts. That length gate turns out to be redundant
  // with the grouping logic below, not just wrong: a genuinely short
  // multi-sentence definition (e.g. "Used for approach guidance. See FAR
  // 91.175.") never exceeds TARGET_CHUNK_LENGTH while merging, so the loop
  // naturally re-combines it into one chunk and the `chunks.length > 1`
  // check below falls through to the original single block anyway --
  // removing the length gate stops rejecting the medium-length (150-380
  // char) cases that make up most of the actual "chunky paragraph" reports
  // without introducing any new over-splitting of short text. Verified
  // directly: SHARPTT now splits into 2 chunks at its real sentence
  // boundaries; the short 2-sentence example above still returns unsplit.
  const sentences = trimmed.split(SENTENCE_BOUNDARY_RE)
  if (sentences.length < 2) return [trimmed]

  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence
    if (current && candidate.length > TARGET_CHUNK_LENGTH) {
      chunks.push(current)
      current = sentence
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)

  // A split that produced only one real chunk back (e.g. one giant
  // sentence with no internal boundary under the target length) gained
  // nothing — return the original rather than an oddly-labeled single-item
  // array.
  return chunks.length > 1 ? chunks : [trimmed]
}
