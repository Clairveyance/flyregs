// Document numbers whose source PDF is a scanned original with an OCR text
// layer (Adobe's "HiddenHorzOCR" font, confirmed via scripts/detect_ocr_scans.py)
// rather than a real digital text layer — any garbling in their extracted
// text (misread characters like "OESCRtPTION" for "DESCRIPTION") is inherent
// to the old paper scan, not a FlyRegs extraction bug. Surfaced as a small
// disclaimer + "#N of M" badge on the AC detail screen, and a small marker in
// card/list views, so a reader isn't left thinking the app mangled the text.
//
// Static list rather than a DB column: regenerate the SET of affected docs by
// running `python3 scripts/detect_ocr_scans.py`. The sequence number assigned
// to each document below is PERMANENT once shipped — it's shown to users
// ("#3 of 68") and must never shift for a document that's already listed, or
// a reader could see the same AC's number change between app versions for no
// reason. If a re-scan finds a genuinely new scanned-original AC (a new FAA
// upload of very old paper that wasn't in the catalog before), APPEND it with
// the next unused number; never renumber or re-sort the existing entries.
export const OCR_SCANNED_ACS: ReadonlyArray<string> = [
  '00-31A', '00-44II', '00-59', '121-6', '135.169-1', '150/5300-7B', '170-6C',
  '20-100', '20-104', '20-107B', '20-119', '20-120', '20-133', '20-134',
  '20-143', '20-147A', '20-149B', '20-153B', '20-161', '20-170', '20-171',
  '20-175', '20-30B', '20-40', '20-41A', '20-42D', '20-47', '20-68B', '20-69',
  '20-74', '21-21', '21-22', '21-26A', '21-31A', '21-34', '21-45', '21-47',
  '21-48', '21-49', '21-4B', '21-50', '21-51', '21.101-1B', '21.17-3', '23-9',
  '23.1311-1C', '25-19A', '25-32', '25.307-1', '25.335-1A', '25.703-1',
  '25.773-1', '25.812-1A', '25.856-1', '25.939-1', '33.70-3', '33.76-1B',
  '35.16-1', '36-1H', '36-3H', '39-9', '437.55-1', '45-3A', '91-61', '91-62A',
  '91-66', '91-76A', '91-77',
  // 2026-07-11: AC 38-1 had ZERO extractable characters in the source PDF at
  // all (not even a bad embedded scan-OCR layer -- its text was flattened to
  // vector paths with no ToUnicode mapping) -- a step worse than every entry
  // above, which at least have SOME native text to work with. Recovered via
  // our own fresh OCR pass (easyocr) run against rendered page images, added
  // here so it gets the same disclaimer/counter treatment. See
  // NO_ARTIFACT_REPAIR_ACS below -- this entry deliberately does NOT get the
  // letter-merge repair in acFormat.ts, since that heuristic targets a
  // garbling pattern specific to the OLD embedded-scan OCR layers above, not
  // our own OCR output (verified: applying it wrongly squished "weight/s
  // ranges" into "weight/sranges" on this AC's text).
  '38-1',
]

export const OCR_SCANNED_TOTAL = OCR_SCANNED_ACS.length

// document_number -> permanent 1-indexed sequence number ("#N of M").
const OCR_SCANNED_INDEX: ReadonlyMap<string, number> = new Map(
  OCR_SCANNED_ACS.map((doc, i) => [doc, i + 1])
)

export function isOcrScanned(documentNumber: string): boolean {
  return OCR_SCANNED_INDEX.has(documentNumber)
}

/** Returns the permanent "#N" for this AC, or null if it isn't a scanned original. */
export function ocrScannedSeq(documentNumber: string): number | null {
  return OCR_SCANNED_INDEX.get(documentNumber) ?? null
}

// Subset of OCR_SCANNED_ACS whose text was recovered via OUR OWN fresh OCR
// pass rather than inherited from the PDF's own old embedded scan-OCR layer.
// acFormat.ts's letter-merge repair heuristic (isNoOcrArtifactRepair below)
// is specifically shaped for the OLD layer's garbling pattern and actively
// corrupts otherwise-clean modern OCR output (see comment on '38-1' above) --
// exclude these from that repair while still getting the same disclaimer
// banner as every other OCR_SCANNED_ACS entry.
const NO_ARTIFACT_REPAIR_ACS: ReadonlySet<string> = new Set(['38-1'])

export function needsOcrArtifactRepair(documentNumber: string): boolean {
  return isOcrScanned(documentNumber) && !NO_ARTIFACT_REPAIR_ACS.has(documentNumber)
}
