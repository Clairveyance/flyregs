// Reads a file of doc_numbers (one per line, produced by faa_scraper.py's
// --vision-recovered-out) and appends any not already present to
// OCR_SCANNED_ACS in src/lib/ocrScannedACs.ts, each with a dated comment
// explaining why. Only ever APPENDS -- existing entries and their sequence
// numbers (assigned purely by array position, see that file's own header
// comment) are never touched, reordered, or renumbered.
//
// A no-op (prints why, exits 0) if the file is missing, empty, or every doc
// in it is already listed -- the normal case for almost every weekly run,
// since vision recovery itself only fires on a genuine text-health failure.
//
// Usage: node scripts/append_ocr_scanned_acs.mjs <docs-file>

import fs from 'fs'

const docsFile = process.argv[2]
if (!docsFile || !fs.existsSync(docsFile)) {
  console.log('No vision-recovered docs file — nothing to append.')
  process.exit(0)
}

const newDocs = fs.readFileSync(docsFile, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)

if (newDocs.length === 0) {
  console.log('Vision-recovered docs file is empty — nothing to append.')
  process.exit(0)
}

const tsPath = 'src/lib/ocrScannedACs.ts'
const src = fs.readFileSync(tsPath, 'utf8')

// Same comment-stripping quoted-string extraction already validated in
// scripts/llm_rebuild_ocr_docs.py's get_ocr_scanned_docs() -- a real
// apostrophe inside an explanatory comment (e.g. "AC's text)") otherwise
// corrupts a naive quote-matching regex and can silently drop an entry.
const arrayStart = src.indexOf('[', src.indexOf('OCR_SCANNED_ACS'))
const arrayEnd = src.indexOf(']', arrayStart)
const arrayBody = src.slice(arrayStart, arrayEnd).replace(/\/\/[^\n]*/g, '')
const existing = new Set([...arrayBody.matchAll(/'([^']+)'/g)].map((m) => m[1]))

const toAdd = newDocs.filter((d) => !existing.has(d))
if (toAdd.length === 0) {
  console.log('All vision-recovered docs are already in OCR_SCANNED_ACS — nothing to append.')
  process.exit(0)
}

const today = new Date().toISOString().slice(0, 10)
const comment = `  // ${today}: auto-added after an automatic vision recovery (flattened/signed source PDF, caught by the weekly sync's text-health check) -- see the vision_recovery_log table for detail.\n`
const entries = toAdd.map((d) => `  '${d}',`).join('\n') + '\n'

fs.writeFileSync(tsPath, src.slice(0, arrayEnd) + comment + entries + src.slice(arrayEnd))

console.log(`Appended ${toAdd.length} doc(s) to OCR_SCANNED_ACS: ${toAdd.join(', ')}`)
