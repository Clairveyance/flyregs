// Corpus-wide formatting-quality audit for FAR/AIM/AD/49-CFR -- the
// coverage gap flagged 2026-08-17: scripts/audit_corpus_formatting.py
// covers AC (pdf_text + pdf_blocks) but nothing else does, even though
// FAR/AIM/P-CG/AD/LOI/49-CFR all render through the SAME shared pipeline
// (src/lib/regTextFormat.ts + PlainTextBody.tsx, confirmed live: every one
// of far/aim/ad/cfr49/pcg/loi/[id].tsx imports PlainTextBody). AC is the
// one type with its own separate architecture (pre-parsed pdf_blocks, not
// paragraph-split at render time), which is why it already had its own
// audit and needed a different one, not why the others got skipped.
//
// Read-only, re-runnable, no writes -- same contract as
// audit_corpus_formatting.py. Deliberately NOT part of run_all_audits.sh:
// like that script, this produces a manual-triage worklist (real, but not
// necessarily wrong -- some flagged docs are genuinely dense), not a
// binary pass/fail gate.
//
// Runs the checks against text ALREADY PUT THROUGH normalizeRegBody() --
// the exact function PlainTextBody actually renders through -- not the
// raw body_text column. This matters: regTextFormat.ts's own header
// comment documents that AD source text is ~81% littered with
// "[[Page NNNN]]" markers and hard-wrapped lines, but normalizeRegBody()
// already strips/rejoins those at render time. Auditing raw body_text
// would re-flag thousands of already-handled artifacts as if they were
// new findings; auditing the post-normalize text finds only what
// actually reaches a real screen.
//
// Checks (mirrors audit_corpus_formatting.py's two, adapted to a
// paragraph-based model since these types have no pdf_blocks array):
//   1. FOOTER BOILERPLATE: a short repeating span containing both a
//      date-like token and (part of) the document's own identifying
//      number -- the exact shape found corpus-wide in AC's pdf_text.
//      Genuinely uncertain going in whether this exists here too (AC's
//      version came from PDF page footers; FAR/AIM/P-CG are eCFR-sourced
//      with no page concept, AD/49-CFR are Federal-Register-sourced,
//      closer to AC's own source lineage) -- that uncertainty is exactly
//      why this check needs to exist and run for real, not be assumed
//      away.
//   2. OVERSIZED PARAGRAPHS: a paragraph (post-normalize) that's both
//      >6000 chars AND >6x that same document's own median paragraph
//      length -- document-relative, same reasoning as AC's version (some
//      documents are legitimately dense throughout; this only flags a
//      paragraph that's an outlier WITHIN ITS OWN document). Gated on
//      >=5 paragraphs per document, same as AC's version, so a
//      naturally-short single-paragraph FAR section never gets flagged
//      against itself. 6000 chars (not AC's 8000) because these body
//      fields run shorter overall than a full AC's pdf_text.
//
// Usage: node scripts/audit_reg_formatting.mjs

import { createClient } from '@supabase/supabase-js'
import ts from 'typescript'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

const envPath = path.resolve('.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

// regTextFormat.ts imports softWrapParagraph from './softWrap' -- transpile
// both into the same tmp dir so the relative specifier resolves, same
// pattern as backfill-blocks.mjs uses for acFormat.ts's own dependency.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-fmt-audit-'))
const transpile = (relSrcPath) =>
  ts.transpileModule(fs.readFileSync(path.resolve(relSrcPath), 'utf8'), {
    compilerOptions: { module: 'ES2020', target: 'ES2020' },
  }).outputText
fs.writeFileSync(path.join(tmpDir, 'softWrap.mjs'), transpile('src/lib/softWrap.ts'))
const regFmtJs = transpile('src/lib/regTextFormat.ts').replace(
  "from '@/lib/softWrap'",
  "from './softWrap.mjs'",
)
const tmp = path.join(tmpDir, 'regTextFormat.mjs')
fs.writeFileSync(tmp, regFmtJs)
const { normalizeRegBody } = await import(pathToFileURL(tmp).href)

const DATE_RE = /\d{1,2}\/\d{1,2}\/\d{2,4}/g

function findFooterBoilerplate(ownNumber, text) {
  const candidates = {}
  const ownDigits = (ownNumber.match(/\d{2,}/g) || [])
  if (ownDigits.length === 0) return {}
  let m
  while ((m = DATE_RE.exec(text))) {
    const windowStart = Math.max(0, m.index - 60)
    const window = text.slice(windowStart, m.index + m[0].length + 60)
    if (!ownDigits.some((d) => window.includes(d))) continue
    const coreStart = Math.max(0, m.index - 20)
    const core = text.slice(coreStart, m.index + m[0].length + 20).replace(/\s+/g, ' ').trim()
    if (core.length < 15) continue
    candidates[core] = (candidates[core] || 0) + 1
  }
  const real = {}
  for (const [k, v] of Object.entries(candidates)) if (v >= 3) real[k] = v
  return real
}

function oversizedParagraph(paragraphs) {
  const lens = paragraphs.map((p) => p.length)
  if (lens.length < 5) return null
  const sorted = [...lens].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const worst = Math.max(...lens)
  if (worst > 6000 && median > 0 && worst > median * 6) {
    return { worst, median, n: lens.length }
  }
  return null
}

const TARGETS = [
  { table: 'far_sections', idCol: 'section_number', textCol: 'body_text', label: 'FAR' },
  { table: 'aim_paragraphs', idCol: 'paragraph_number', textCol: 'body_text', label: 'AIM' },
  { table: 'airworthiness_directives', idCol: 'ad_number', textCol: 'body_text', label: 'AD' },
  { table: 'cfr49_sections', idCol: 'section_number', textCol: 'body_text', label: '49 CFR' },
]

const allFooterHits = []
const allOversizedHits = []

for (const { table, idCol, textCol, label } of TARGETS) {
  console.log(`\nFetching ${label} (${table})...`)
  let rows = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(`${idCol}, ${textCol}`)
      .not(textCol, 'is', null)
      .range(from, from + PAGE - 1)
    if (error) { console.error(`  fetch error: ${error.message}`); break }
    if (!data || data.length === 0) break
    rows = rows.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }
  console.log(`  ${rows.length} rows loaded.`)

  let footerCount = 0
  let oversizedCount = 0
  for (const row of rows) {
    const ownId = row[idCol]
    const raw = row[textCol] || ''
    const normalized = normalizeRegBody(raw)
    if (!normalized) continue

    const boilerplate = findFooterBoilerplate(ownId, normalized)
    if (Object.keys(boilerplate).length > 0) {
      footerCount++
      const [snippet, count] = Object.entries(boilerplate).sort((a, b) => b[1] - a[1])[0]
      allFooterHits.push({ type: label, id: ownId, snippet, count })
    }

    const paragraphs = normalized.split('\n\n').filter((p) => p.trim())
    const oversized = oversizedParagraph(paragraphs)
    if (oversized) {
      oversizedCount++
      allOversizedHits.push({ type: label, id: ownId, ...oversized })
    }
  }
  console.log(`  ${label}: ${footerCount} footer-boilerplate hit(s), ${oversizedCount} oversized-paragraph hit(s).`)
}

console.log(`\n=== FOOTER BOILERPLATE bleeding into rendered text: ${allFooterHits.length} document(s) ===`)
for (const h of allFooterHits.sort((a, b) => b.count - a.count).slice(0, 60)) {
  console.log(`  ${h.type.padEnd(6)} ${String(h.id).padEnd(16)} x${String(h.count).padEnd(3)} ${JSON.stringify(h.snippet.slice(0, 70))}`)
}

console.log(`\n=== OVERSIZED PARAGRAPHS (document-relative outlier): ${allOversizedHits.length} document(s) ===`)
for (const h of allOversizedHits.sort((a, b) => b.worst - a.worst).slice(0, 60)) {
  console.log(`  ${h.type.padEnd(6)} ${String(h.id).padEnd(16)} worst=${String(h.worst).padEnd(7)} median=${String(h.median).padEnd(6)} n_paragraphs=${h.n}`)
}

const outPath = 'scripts/audit_reports/reg_formatting_latest.json'
fs.writeFileSync(outPath, JSON.stringify({ footer_boilerplate: allFooterHits, oversized_paragraphs: allOversizedHits }, null, 1))
console.log(`\nFull results: ${outPath}`)
