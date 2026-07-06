// Scans all active ACs for OCR word-split artifacts (spaces inserted within words
// during PDF extraction, e.g. "res ult" → "result", "annoya nce" → "annoyance").
// Classifies each pattern as HIGH confidence (auto-fixable) or REVIEW (needs human).
// Output: a JSON report of fixes + a human-readable summary.

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

// ── Word list ──────────────────────────────────────────────────────────────────
const WORDS = new Set(
  fs.readFileSync('/usr/share/dict/words', 'utf8')
    .split('\n')
    .map(w => w.toLowerCase().trim())
    .filter(w => w.length >= 2)
)

// Short English words that could legitimately precede another word — their
// presence as t1 means we cannot safely auto-merge (risk merging "in deed" →
// "indeed" when those are separate words in a sentence).
const AMBIGUOUS_FIRST = new Set([
  'a','i','o',
  'an','as','at','be','by','do','go','he','if','in','is','it','me','my',
  'no','of','on','or','so','to','up','us','we',
  'and','are','but','did','for','get','got','had','has','him','his','how',
  'its','may','not','off','our','out','per','put','run','see','set','she',
  'the','two','use','via','was','who','why','yet','you',
  'all','can','any','new','one','own','try','way',
  // aviation/common abbrevs that could appear mid-sentence
  'alt','nav','apr','dep','apr',
])

// Patterns where the second fragment is a common standalone word — also risky
const AMBIGUOUS_SECOND = new Set([
  'a','i','o','s',
  'an','as','at','be','by','do','go','he','if','in','is','it','me','my',
  'no','of','on','or','so','to','up','us','we',
  'and','are','but','for','had','has','him','his','how',
  'its','may','not','off','our','out','per','run','see','set','she',
  'the','two','use','via','was','who','why','yet','you','all','can',
])

// Words that look like real words but are known OCR fragment artifacts.
// These override AMBIGUOUS_FIRST — we know "th e" means "the".
const KNOWN_FRAGMENTS = new Set([
  'th','wi','wh','fi','fl','fo','fr','gr','pr','tr','sp','st','ch','sh',
  'qu','pl','cl','br','bl','cr','dr','gl','sk','sl','sm','sn','sw','tw',
])

// ── Scanner ───────────────────────────────────────────────────────────────────
function scanText(pdfText) {
  // aggregate: "t1 t2" → { combined, count, t1InDict, t2InDict, lineExamples }
  const patterns = new Map()

  const lines = pdfText.split('\n')
  for (const line of lines) {
    const trimmed = line.replace(/\s+/g, ' ').trim()
    if (trimmed.length < 6) continue

    const rawTokens = trimmed.split(' ')
    for (let i = 0; i < rawTokens.length - 1; i++) {
      // Strip punctuation from both sides; keep only alpha chars
      const t1 = rawTokens[i].replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '').toLowerCase()
      const t2 = rawTokens[i + 1].replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '').toLowerCase()

      // Both must be purely lowercase (uppercase start = sentence start or proper noun)
      if (!/^[a-z]+$/.test(t1) || !/^[a-z]+$/.test(t2)) continue

      // Fragment length constraints: catch 2–8 char fragments
      if (t1.length < 2 || t1.length > 8) continue
      if (t2.length < 2 || t2.length > 9) continue

      const combined = t1 + t2
      if (combined.length < 5 || combined.length > 16) continue

      // Combined must form a real word
      if (!WORDS.has(combined)) continue

      // Skip if both fragments are themselves common standalone words
      // (these are likely legitimate two-word phrases, not OCR splits)
      const t1IsWord = WORDS.has(t1)
      const t2IsWord = WORDS.has(t2)
      if (t1IsWord && t2IsWord && !KNOWN_FRAGMENTS.has(t1)) continue

      const key = `${t1} ${t2}`
      const existing = patterns.get(key)
      if (existing) {
        existing.count++
        if (existing.examples.length < 3) existing.examples.push(trimmed.slice(0, 80))
      } else {
        patterns.set(key, {
          combined, count: 1, t1IsWord, t2IsWord,
          examples: [trimmed.slice(0, 80)],
        })
      }
    }
  }
  return patterns
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('Loading ACs from Supabase…')
const { data: acs, error } = await supabase
  .from('advisory_circulars')
  .select('id, document_number, date_issued, pdf_text')
  .eq('status', 'active')
  .not('pdf_text', 'is', null)

if (error) { console.error(error); process.exit(1) }
console.log(`Scanning ${acs.length} ACs…`)

// Global aggregation: key → { combined, totalCount, acs: Map<docnum, count> }
const globalPatterns = new Map()

let processed = 0
for (const ac of acs) {
  if (!ac.pdf_text) continue
  const found = scanText(ac.pdf_text)
  for (const [key, info] of found) {
    const g = globalPatterns.get(key)
    if (g) {
      g.totalCount += info.count
      g.acs.set(ac.document_number, (g.acs.get(ac.document_number) || 0) + info.count)
      g.t1IsWord = info.t1IsWord
      g.t2IsWord = info.t2IsWord
      if (g.examples.length < 3) g.examples.push(...info.examples)
    } else {
      globalPatterns.set(key, {
        combined: info.combined,
        totalCount: info.count,
        t1IsWord: info.t1IsWord,
        t2IsWord: info.t2IsWord,
        acs: new Map([[ac.document_number, info.count]]),
        examples: [...info.examples],
      })
    }
  }
  processed++
  if (processed % 100 === 0) process.stdout.write(`  …${processed}\n`)
}

console.log(`Done scanning ${processed} ACs. Found ${globalPatterns.size} candidate patterns.\n`)

// ── Classify ──────────────────────────────────────────────────────────────────
const AUTO = []   // High confidence: safe to fix automatically
const REVIEW = [] // Ambiguous: show to user for approval

for (const [key, info] of globalPatterns) {
  const [t1, t2] = key.split(' ')
  const acList = [...info.acs.entries()].sort((a, b) => b[1] - a[1])
  const entry = {
    pattern: key,
    fix: info.combined,
    totalCount: info.totalCount,
    acCount: info.acs.size,
    topACs: acList.slice(0, 5).map(([n, c]) => `${n}(${c})`).join(', '),
    examples: info.examples.slice(0, 2),
  }

  const isKnownFragment = KNOWN_FRAGMENTS.has(t1)
  const firstAmbiguous = AMBIGUOUS_FIRST.has(t1) && !isKnownFragment
  const secondAmbiguous = AMBIGUOUS_SECOND.has(t2)

  if (firstAmbiguous || secondAmbiguous) {
    entry.reason = firstAmbiguous
      ? `"${t1}" is a valid English word (preposition/article) — may be two real words`
      : `"${t2}" is a common word — may be two separate words`
    REVIEW.push(entry)
  } else {
    AUTO.push(entry)
  }
}

// Sort by frequency
AUTO.sort((a, b) => b.totalCount - a.totalCount)
REVIEW.sort((a, b) => b.totalCount - a.totalCount)

// ── Output ────────────────────────────────────────────────────────────────────
const outPath = path.resolve(process.cwd(), 'scripts/ocr-splits-report.json')
fs.writeFileSync(outPath, JSON.stringify({ auto: AUTO, review: REVIEW }, null, 2))
console.log(`Full report saved to scripts/ocr-splits-report.json\n`)

console.log(`════════════════════════════════════════════════════════════`)
console.log(`HIGH CONFIDENCE (${AUTO.length} patterns — both fragments are non-words)`)
console.log(`════════════════════════════════════════════════════════════`)
for (const e of AUTO) {
  console.log(`  "${e.pattern}" → "${e.fix}"  [${e.totalCount}x in ${e.acCount} AC${e.acCount !== 1 ? 's' : ''}: ${e.topACs}]`)
}

console.log(`\n════════════════════════════════════════════════════════════`)
console.log(`NEEDS REVIEW (${REVIEW.length} patterns — first/second fragment is a real word)`)
console.log(`════════════════════════════════════════════════════════════`)
for (const e of REVIEW) {
  console.log(`  "${e.pattern}" → "${e.fix}"  [${e.totalCount}x in ${e.acCount} AC${e.acCount !== 1 ? 's' : ''}]  ⚠ ${e.reason}`)
}
