// Applies curated OCR word-split fixes to pdf_text in Supabase.
// These are cases where PDF extraction inserted spaces inside words,
// e.g. "em ergency" → "emergency", "shou ld" → "should".
//
// Usage:
//   node scripts/apply-ocr-fixes.mjs --dry-run           # show AC-level counts, no writes
//   node scripts/apply-ocr-fixes.mjs --dry-run 91-36D    # show line diffs for one AC
//   node scripts/apply-ocr-fixes.mjs                     # apply to all ACs

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

// ── False positives: combined forms that must NOT be merged ───────────────────
// Each entry is the (wrong) combined word the scanner would produce.
// Pattern → why it's a false positive
const FALSE_POSITIVE_COMBINED = new Set([
  'thave',          // "th ave" — "75th Ave." street address, not split "thave"
  'underspecified', // "under specified" — two real words in a phrase
  'acone',          // "ac one" — "AC one" = Advisory Circular reference
  'individua',      // "individ ua" — sub-fragment of triple-split "individ ua l ly"
  'nance',          // "na nce" — sub-fragment of triple-split "mainte na nce"
  'actable',        // "ac table" — "AC. Table" = document section cross-reference
  'irradiant',      // "ir radiant" — "IR Radiant" = infrared technical term
  'parisii',        // "paris ii" — "PARIS II" = Morane-Saulnier aircraft model name
  'atlatl',         // "atl atl" — "!ATL ATL" = NOTAM header for Atlanta airport
  'multisector',    // "multi sector" — "Multi Sector General Permit" = EPA proper name
  'hasan',          // "has an" — two separate words ("has an intensity")
  'beheld',         // "be held" — passive voice ("must be held perpendicular")
  'bepaid',         // "be paid" — passive voice ("a fee to be paid")
  'incomplying',    // "in complying" — two real words; not a word
  'tongs',          // "to ngs" — "to NGS" = National Geodetic Survey abbreviation
  'acoin',          // "aco in" — "(ACO) in" = Aircraft Certification Office
  'their',          // "the ir" — "the IR" = infrared; scanner found "th ese" for "these" separately
  'india',          // "in dia" — "IN. DIA" = inch diameter (technical notation)
  'thecia',         // "the cia" — "The CIA" = Certification Information Activity
  'spoor',          // "spo or" — "SPO, or" = technical abbreviation
  'papion',         // "papi on" — "PAPI on" = PAPI (approach light system) preposition
  'order',          // "or der" — "or DER" = Designated Engineering Representative abbreviation
  'bever',          // "be ver" — fragment of "can be very" cut at line end
  'persae',         // "per sae" — "per SAE" = SAE standard reference
  'bepatched',      // "be patched" — passive voice ("pavement to be patched")
])

// ── Load AUTO patterns from the scan report ───────────────────────────────────
const report = JSON.parse(fs.readFileSync('scripts/ocr-splits-report.json'))
const autoFixes = report.auto
  .filter(e => !FALSE_POSITIVE_COMBINED.has(e.fix))
  .map(e => ({ pattern: e.pattern, fix: e.fix }))

// ── Confirmed OCR splits from the REVIEW list ─────────────────────────────────
// The scanner flagged these because one fragment is a common English word,
// but example context confirmed they are genuine OCR splits.
const reviewFixes = [
  { pattern: 'softw are',   fix: 'software'   }, // "hardw are and softw are capabilities"
  { pattern: 'hardw are',   fix: 'hardware'   }, // "GDRAS hardw are and softw are"
  { pattern: 'analys is',   fix: 'analysis'   }, // "Cause Analys is (RCA)"
  { pattern: 'me dical',    fix: 'medical'    }, // "health and me dical organizations"
  { pattern: 'continuo us', fix: 'continuous' }, // "Continuo us Airworthiness"
  { pattern: 'conditi on',  fix: 'condition'  }, // "fault conditi on or a low-level failure"
  { pattern: 'in cident',   fix: 'incident'   }, // "In cident Action Plan"
  { pattern: 'violati on',  fix: 'violation'  }, // "voluntary disclosure if the violati on"
  { pattern: 'secti on',    fix: 'section'    }, // "previous secti on or are independently"
  { pattern: 'operati on',  fix: 'operation'  }, // "times of facility operati on"
  { pattern: 'functi on',   fix: 'function'   }, // "performs the same functi on"
  { pattern: 'in spect',    fix: 'inspect'    }, // "in spect the EUT for evidence"
  { pattern: 'inst all',    fix: 'install'    }, // "Inst all castle nuts"
  { pattern: 'no ise',      fix: 'noise'      }, // "th e FAA No ise Po licy"
  { pattern: 'so ftware',   fix: 'software'   }, // "Unless so ftware partitioning"
  { pattern: 'in tended',   fix: 'intended'   }, // "this AC is in tended to help"
  { pattern: 'in clude',    fix: 'include'    }, // "Be sure to in clude the revision"
  { pattern: 'he ight',     fix: 'height'     }, // "he ight (Z) respectively"
  { pattern: 'we ight',     fix: 'weight'     }, // "the we ight and center of gravity"
]

// ── Combined fix list ─────────────────────────────────────────────────────────
const allFixes = [...autoFixes, ...reviewFixes]

// Pre-compile all regexes (word-boundary match, case-insensitive)
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
const compiled = allFixes.map(({ pattern, fix }) => {
  const [t1, t2] = pattern.split(' ')
  const re = new RegExp(`\\b${escRe(t1)} ${escRe(t2)}\\b`, 'gi')
  return { re, fix }
})

function applyFixes(text) {
  let result = text
  let count = 0
  for (const { re, fix } of compiled) {
    re.lastIndex = 0
    result = result.replace(re, (match) => {
      count++
      // Preserve initial capitalisation (e.g. "Shou ld" → "Should")
      return /^[A-Z]/.test(match) ? fix[0].toUpperCase() + fix.slice(1) : fix
    })
  }
  return { result, count }
}

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const DRY_RUN  = args.includes('--dry-run')
const NEW_ONLY = args.includes('--new-only')  // only ACs without parsed blocks (freshly scraped)
const ONLY_AC  = args.find(a => !a.startsWith('-')) ?? null

console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}${allFixes.length} fix patterns${NEW_ONLY ? ' (new/updated ACs only)' : ''}\n`)

// ── Process ACs in pages to avoid query timeout ───────────────────────────────
const PAGE = 25
let offset = 0
let updatedCount = 0
let totalChanges = 0
let scanned = 0

for (;;) {
  let q = supabase
    .from('advisory_circulars')
    .select('id, document_number, pdf_text')
    .eq('status', 'active')
    .not('pdf_text', 'is', null)
    .order('document_number')
    .range(offset, offset + PAGE - 1)

  // --new-only: only ACs whose pdf_blocks_version was cleared by the scraper
  if (NEW_ONLY) q = q.is('pdf_blocks_version', null)
  if (ONLY_AC)  q = q.eq('document_number', ONLY_AC)

  const { data: acs, error } = await q
  if (error) { console.error(error); process.exit(1) }
  if (!acs || acs.length === 0) break

  for (const ac of acs) {
    if (!ac.pdf_text) continue
    scanned++
    const { result, count } = applyFixes(ac.pdf_text)
    if (count === 0) continue

    totalChanges += count
    updatedCount++

    if (DRY_RUN) {
      process.stdout.write(`${ac.document_number}: ${count} fix${count !== 1 ? 'es' : ''}\n`)
      if (ONLY_AC) {
        const origLines = ac.pdf_text.split('\n')
        const fixedLines = result.split('\n')
        for (let i = 0; i < Math.max(origLines.length, fixedLines.length); i++) {
          if (origLines[i] !== fixedLines[i]) {
            console.log(`  line ${i + 1}:`)
            console.log(`    - ${(origLines[i] ?? '').trim()}`)
            console.log(`    + ${(fixedLines[i] ?? '').trim()}`)
          }
        }
      }
    } else {
      const { error: upErr } = await supabase
        .from('advisory_circulars')
        .update({ pdf_text: result })
        .eq('id', ac.id)
      if (upErr) {
        console.error(`  ✗ ${ac.document_number}: ${upErr.message}`)
      } else if (updatedCount % 50 === 0) {
        console.log(`  …updated ${updatedCount} ACs`)
      }
    }
  }

  if (ONLY_AC || acs.length < PAGE) break
  offset += PAGE
}

console.log()
console.log(`Scanned ${scanned} ACs — ${DRY_RUN ? 'would update' : 'updated'} ${updatedCount} with ${totalChanges} total word-split corrections`)
if (!DRY_RUN && updatedCount > 0) {
  console.log('\nNext: run node scripts/backfill-blocks.mjs to regenerate parsed blocks.')
}
