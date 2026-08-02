#!/usr/bin/env node
// Corpus-wide audit of PlainTextBody.tsx's parseTableBlock() group-label
// logic -- mirrors the EXACT same algorithm (copy-pasted, not reimplemented
// from scratch, to avoid translation drift) and runs it against every FAR +
// AIM table block that mixes piped rows with bare (non-piped) lines, then
// flags anything that LOOKS like a parsing failure: a first cell that's
// implausibly long, or one that repeats the same phrase twice (the exact
// shape of the "stale sub-label glued onto a self-contained row" bug found
// live on FAR 91.155 and fixed once already -- this checks whether the fix
// actually holds across the other ~180 affected blocks, not just that one).
//
// Run from ac-app/: node scripts/audit_table_group_labels.mjs

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = path.dirname(__dirname)

function loadEnv(name) {
  const env = {}
  for (const line of fs.readFileSync(path.join(BASE, name), 'utf8').split('\n')) {
    const l = line.trim().replace(/^export\s+/, '')
    if (!l || l.startsWith('#')) continue
    const i = l.indexOf('=')
    env[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return env
}

const scraper = loadEnv('.env.scraper')
const sb = createClient(scraper.SUPABASE_URL, scraper.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

// ---- mirrored from PlainTextBody.tsx (keep in sync if that file changes) ----
const LEADING_MARKER_RE = /^(\([a-zA-Z0-9]{1,4}\)|[a-zA-Z0-9]{1,3}\.)\s+/

function sharesLeadWords(a, b, minWords = 3) {
  const aw = a.toLowerCase().split(/\s+/)
  const bw = b.toLowerCase().split(/\s+/)
  let n = 0
  while (n < aw.length && n < bw.length && aw[n] === bw[n]) n++
  return n >= minWords
}

function parseTableBlock(para) {
  const lines = para.split('\n').map((l) => l.trim()).filter(Boolean)
  const pipedIdx = lines.findIndex((l) => l.includes(' | '))
  if (pipedIdx === -1) return null
  const pipedLineIdxs = lines.map((l, idx) => (idx >= pipedIdx && l.includes(' | ') ? idx : -1)).filter((idx) => idx >= 0)
  // No TABLE_HEADER_MARK available outside the app (it's an invisible
  // marker char injected by the scraper) -- treat the first piped line as
  // the header unconditionally. Slightly more permissive than the real
  // component, but doesn't affect row-content correctness, only whether
  // row 0 is labeled "header" vs "data" -- irrelevant to this audit.
  const headerIdxs = [pipedIdx]
  const dataIdxs = pipedLineIdxs.filter((idx) => idx !== pipedIdx)
  if (pipedLineIdxs.length < 2) return null

  let currentClass = null
  let subLabel = null
  const dataIdxSet = new Set(dataIdxs)
  const headerIdxSet = new Set(headerIdxs)
  const rows = []
  for (let idx = pipedIdx + 1; idx < lines.length; idx++) {
    if (dataIdxSet.has(idx)) {
      const cells = lines[idx].split(' | ').map((c) => c.trim())
      const redundant = subLabel != null && sharesLeadWords(subLabel, cells[0])
      const prefix = [currentClass, redundant ? null : subLabel].filter(Boolean).join(' — ')
      if (prefix) cells[0] = `${prefix} — ${cells[0]}`
      if (redundant) subLabel = null
      rows.push(cells)
    } else if (!headerIdxSet.has(idx)) {
      const raw = lines[idx]
      if ((/\.$/.test(raw) || LEADING_MARKER_RE.test(raw)) && rows.length > 0) {
        const lastRow = rows[rows.length - 1]
        lastRow[lastRow.length - 1] = `${lastRow[lastRow.length - 1]} ${raw}`
      } else {
        const label = raw.replace(/:\s*$/, '')
        if (/^Class\s+[A-Za-z0-9]+$/.test(label)) {
          currentClass = label
          subLabel = null
        } else {
          subLabel = label
        }
      }
    }
  }
  return { headerCells: lines[pipedIdx].split(' | ').map((c) => c.trim()), rows }
}
// ---- end mirror ----

function hasRepeatedPhrase(text) {
  // Crude duplicate-content detector: any 4-word run appearing twice.
  const words = text.split(/\s+/)
  const seen = new Set()
  for (let i = 0; i + 4 <= words.length; i++) {
    const gram = words.slice(i, i + 4).join(' ').toLowerCase()
    if (gram.length < 12) continue // skip short/common runs
    if (seen.has(gram)) return gram
    seen.add(gram)
  }
  return null
}

async function fetchAll(table, idCol, cols) {
  const out = []
  let offset = 0
  const page = 1000
  while (true) {
    const { data, error } = await sb.from(table).select(cols).range(offset, offset + page - 1)
    if (error) throw error
    out.push(...data)
    if (data.length < page) break
    offset += page
  }
  return out
}

async function main() {
  const far = await fetchAll('far_sections', 'section_number', 'section_number, body_text')
  const aim = await fetchAll('aim_paragraphs', 'paragraph_number', 'paragraph_number, body_text')
  console.log(`Fetched ${far.length} FAR sections, ${aim.length} AIM paragraphs.`)

  const sources = [
    ...far.map((r) => ({ src: 'far', id: r.section_number, body: r.body_text })),
    ...aim.map((r) => ({ src: 'aim', id: r.paragraph_number, body: r.body_text })),
  ]

  let blocksChecked = 0
  let flagged = []
  const MAX_CELL_LEN = 160

  for (const { src, id, body } of sources) {
    if (!body) continue
    const blocks = body.split(/\n\n+/)
    for (const blk of blocks) {
      const lines = blk.split('\n').map((l) => l.trim()).filter(Boolean)
      const piped = lines.filter((l) => l.includes(' | ')).length
      const bare = lines.filter((l) => !l.includes(' | ')).length
      if (piped < 2 || bare < 1) continue
      blocksChecked++
      const parsed = parseTableBlock(blk)
      if (!parsed) continue
      for (const row of parsed.rows) {
        const cell0 = row[0]
        if (cell0.length > MAX_CELL_LEN) {
          flagged.push({ src, id, reason: 'long-cell', cell: cell0 })
          continue
        }
        const dup = hasRepeatedPhrase(cell0)
        if (dup) {
          flagged.push({ src, id, reason: `repeated-phrase("${dup}")`, cell: cell0 })
        }
      }
    }
  }

  console.log(`Checked ${blocksChecked} table blocks with mixed piped/bare lines.`)
  console.log(`Flagged ${flagged.length} rows for manual review:\n`)
  for (const f of flagged) {
    console.log(`[${f.src} ${f.id}] ${f.reason}\n  "${f.cell}"\n`)
  }
  if (flagged.length === 0) console.log('None -- every affected table block produced clean, non-duplicated row labels.')
}

main().catch((e) => { console.error(e); process.exit(1) })
