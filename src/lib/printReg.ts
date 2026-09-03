import * as Print from 'expo-print'
import { Platform } from 'react-native'
import { File, Paths } from 'expo-file-system'
import {
  normalizeRegBody, TABLE_HEADER_MARK, ParsedTable, parseTableBlock, parseADFigureTable, looksLikeRealCaption,
} from '@/lib/regTextFormat'
import { resolveGatedStorageUrl } from '@/lib/gatedStorage'

// "Print & export any section" is sold as a PLUS feature, but until now the
// app had no print at all — the only thing behind that promise was the OS
// share sheet, which exports a LINK, not the text. This is the print half.
//
// Renders the regulation to a clean, paper-shaped HTML document and hands it
// to the platform print dialog (AirPrint / system print on native, the
// browser print dialog on web). Deliberately NOT a screenshot of the app UI:
// a printed reg should read like a document — serif body, real margins, no
// dark theme burning half a toner cartridge.

export interface PrintableFigure {
  id: string
  label?: string | null
  caption?: string | null
  /** The stored "public-style" Storage URL exactly as fetched from
   * ac_figures/aim_figures/ad_figures — figureToDataUri below mints a
   * short-lived signed URL from it at print time (resolveGatedStorageUrl,
   * same call gatedStorage.ts's other callers already make), then embeds
   * the actual bytes. Never rendered as-is: it 401s against the private
   * bucket, same reason useGatedCachedImage never shows it directly. */
  imageUrl: string
}

export interface PrintableReg {
  /** "§ 91.103", "AIM 4-3-13", "AC 90-100B", "AD 2026-15-15", term, slug */
  documentNumber: string
  title?: string | null
  /** Section/paragraph body, P/CG definition, AC description, etc. */
  body: string
  /** "FAR", "AIM", "P/CG", "AC", "AD", "LOI" — shown above the heading. */
  kindLabel: string
  /** Optional line under the title, e.g. an AD's effective date. */
  subtitle?: string | null
  /** Figures/table-page images to embed after the body text — AC/AIM/AD
   * only. FAR/P-CG/LOI/CFR49 have no figures table at all: FAR's own
   * in-body tables are plain-text (handled by bodyToHtml below, not a
   * separate image mechanism), and P-CG/LOI/CFR49 have no figure pipeline
   * whatsoever (verified against every one of those screens directly —
   * none imports FigureViewer or queries a *_figures table). */
  figures?: PrintableFigure[]
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Renders one parsed table (regTextFormat.ts's parseTableBlock/
 * parseADFigureTable — the EXACT same parser PlainTextBody's on-screen
 * TableGrid renders from) as a real HTML <table>, instead of the raw
 * "Col A | Col B | Col C" pipe text with a stray TABLE_HEADER_MARK glyph
 * that bodyToHtml used to just wrap in a bare <p>. `fallbackCaption`
 * mirrors PlainTextBody's own currentLabel fallback (this doc's own
 * documentNumber, the closest print-time equivalent) — used only when the
 * table's own captionLines don't look like a real standalone title, see
 * looksLikeRealCaption's own comment. */
function tableToHtml(table: ParsedTable, fallbackCaption: string): string {
  const hasRealCaption = looksLikeRealCaption(table.captionLines[0])
  const captionLines = hasRealCaption ? table.captionLines : [`Table — ${fallbackCaption}`]
  const caption = captionLines.map((l) => escapeHtml(l)).join('<br/>')
  const colCount = Math.max(table.headerCells?.length ?? 0, ...table.rows.map((r) => r.length), 1)
  const thead = table.headerCells && table.headerCells.length > 0
    ? `<thead><tr>${table.headerCells.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`
    : ''
  // Pads a ragged row out to colCount -- a wrapped continuation that lost a
  // cell is rare but real (see parseTableBlock's own footnote-vs-continuation
  // comment), and without this a short row would shift every following
  // column in that <tr> out of alignment instead of just leaving a blank cell.
  const tbody = table.rows.map((row) => {
    const cells = Array.from({ length: colCount }, (_, i) => row[i] ?? '')
    return `<tr>${cells.map((c, i) => `<td${i === 0 ? ' class="lead"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`
  }).join('')
  const footnotes = table.footnotes.length > 0
    ? `<div class="tbl-footnotes">${table.footnotes.map((f) => `<p>${escapeHtml(f)}</p>`).join('')}</div>`
    : ''
  return `<div class="tbl-wrap"><div class="tbl-caption">${caption}</div><table>${thead}<tbody>${tbody}</tbody></table>${footnotes}</div>`
}

/** Body text -> HTML. Uses the same normalizer + table parser the reg
 * screens render with (regTextFormat.ts), so the printout matches what the
 * user saw rather than re-deriving its own spacing/table rules. A table
 * paragraph becomes a real <table>; every other paragraph is a bare <p>,
 * same as before. */
function bodyToHtml(body: string, fallbackCaption: string): string {
  const normalized = normalizeRegBody(body ?? '')
  return normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const table = parseTableBlock(p) ?? parseADFigureTable(p)
      if (table) return tableToHtml(table, fallbackCaption)
      const cleaned = p
        // Strips TABLE_HEADER_MARK -- see whatsChanged.ts's identical strip
        // for the real bug this guards against: a block that CARRIES the
        // marker (isTabular's signal) but doesn't fully parse as a table
        // (e.g. a single spanning header cell with no " | " of its own)
        // still needs the raw sentinel stripped before it prints, or it
        // renders as a stray invisible-glyph artifact.
        .split(TABLE_HEADER_MARK).join('')
        // Same defensive dash-rule strip PlainTextBody's own non-table
        // fallback applies -- a table shape neither parser recognized (3+
        // columns, a headerless token grid) still shouldn't print raw
        // "----------" divider lines.
        .replace(/^[ \t]*-{10,}[ \t]*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      return `<p>${escapeHtml(cleaned).replace(/\n/g, '<br/>')}</p>`
    })
    .join('\n')
}

/** Turns one figure's stored Storage URL into an embeddable data: URI.
 * Two real constraints forced this instead of just pointing <img src> at
 * the (signed) remote URL directly:
 *  1. The bucket is private (see gatedStorage.ts) -- the URL stored on the
 *     row 401s until resolveGatedStorageUrl mints a short-lived signed one.
 *  2. Per Expo's own SDK 56 docs, printAsync's HTML path on iOS runs
 *     through WKWebView and does not reliably load images from a URL at
 *     all -- the documented workaround is exactly this, an inlined
 *     base64-encoded string. Doing it unconditionally (not just on iOS)
 *     means one code path instead of a per-platform branch that could
 *     silently regress on whichever platform wasn't tested.
 * Returns null (never throws) on any failure -- an unreachable/expired
 * figure shouldn't break the rest of the print job over one image. */
async function figureToDataUri(imageUrl: string): Promise<string | null> {
  const signed = await resolveGatedStorageUrl(imageUrl)
  if (!signed) return null
  try {
    if (Platform.OS === 'web') {
      // expo-file-system's File API has no web implementation (see
      // imageCache.ts's identical caveat) -- plain fetch + FileReader is
      // the standard DOM way to get the same base64 data URI.
      const res = await fetch(signed)
      if (!res.ok) return null
      const blob = await res.blob()
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader()
        reader.onerror = () => resolve(null)
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
        reader.readAsDataURL(blob)
      })
    }
    // Native: download to a throwaway cache file (Paths.cache, not
    // Paths.document -- this copy is only needed for the few seconds it
    // takes to base64-encode it, unlike imageCache.ts's persistent
    // figure cache) and delete it immediately after reading.
    //
    // Every ac_figures/aim_figures/ad_figures row is a scraper-rendered
    // PDF page, and every one of them is a real .png (confirmed against
    // the live DB -- reg-tf-images and ac-figures both store page-N.png /
    // figure-N-N.png, never .jpg). Declaring the data URI as image/jpeg
    // here would have been silently wrong for every real figure this ever
    // runs against -- caught by inspecting an actual captured print
    // payload, not assumed from imageCache.ts's own (unrelated, and
    // itself just a cache filename, not a declared MIME type) ".jpg" cache
    // file naming convention.
    const tmp = new File(Paths.cache, `print_${Date.now()}_${Math.random().toString(36).slice(2)}.png`)
    const downloaded = await File.downloadFileAsync(signed, tmp)
    const base64 = await downloaded.base64()
    try { downloaded.delete() } catch { /* best-effort cleanup, not worth failing the print over */ }
    return `data:image/png;base64,${base64}`
  } catch {
    return null
  }
}

/** Figures/table-page images, rendered as their own section after the body
 * — see PrintableReg.figures. Resolved in parallel; a figure that fails to
 * load is silently dropped rather than failing the whole print job, since
 * the text is the actual point of "Print & export" and an image is a bonus. */
async function figuresToHtml(figures: PrintableFigure[] | undefined): Promise<string> {
  if (!figures || figures.length === 0) return ''
  // BOUNDED POOL, not Promise.all. Each element makes a createSignedUrl round
  // trip, downloads the whole file, and base64-encodes it -- so an unbounded
  // fan-out launched every one of them at once and held every data URI in
  // memory simultaneously before a single byte was printed. AC 43.13-1B has
  // 378 figures (verified live) averaging ~326 KB, i.e. roughly 130 MB of PNG
  // becoming ~173 MB of base64, plus the joined HTML, plus WKWebView's own
  // copy. On an iPhone 13 mini that is a jetsam kill, and the user just sees
  // Print hang and the app die.
  //
  // The identical bug was already found and fixed on the DOWNLOAD path in
  // ac/[id].tsx, which now uses downloadAllToCache(concurrency = 4) with the
  // same arithmetic spelled out. This file never got that treatment.
  //
  // Indexed writes into a pre-sized array, so figures print in their real
  // order regardless of which worker finishes first.
  const CONCURRENCY = 4
  const rendered: (string | null)[] = new Array(figures.length).fill(null)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, figures.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= figures.length) return
        const f = figures[i]
        // Per-figure swallow, matching this function's documented contract:
        // a figure that fails to load is dropped rather than failing the
        // whole print job, since the text is the actual point of Print.
        try {
          const dataUri = await figureToDataUri(f.imageUrl)
          if (!dataUri) continue
          const captionText = [f.label, f.caption].filter(Boolean).join(' — ')
          rendered[i] = `<figure><img src="${dataUri}"/>${captionText ? `<figcaption>${escapeHtml(captionText)}</figcaption>` : ''}</figure>`
        } catch { /* dropped, as above */ }
      }
    }),
  )
  const out = rendered.filter((x): x is string => !!x)
  if (out.length === 0) return ''
  return `<h2 class="figures-heading">Figures &amp; Tables</h2>\n${out.join('\n')}`
}

export async function buildPrintHtml(reg: PrintableReg): Promise<string> {
  const heading = [reg.documentNumber, reg.title].filter(Boolean).join(' — ')
  const printedOn = new Date().toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  })
  const [bodyHtml, figuresHtml] = await Promise.all([
    bodyToHtml(reg.body, reg.documentNumber),
    figuresToHtml(reg.figures),
  ])
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(heading)}</title>
<style>
  @page { margin: 20mm 16mm; }
  * { -webkit-print-color-adjust: exact; }
  body {
    font-family: Georgia, 'Times New Roman', serif;
    color: #111; background: #fff;
    font-size: 11.5pt; line-height: 1.55; margin: 0;
  }
  .kind {
    font-family: Helvetica, Arial, sans-serif;
    font-size: 8.5pt; letter-spacing: 1.4px; text-transform: uppercase;
    color: #6b6b6b; margin-bottom: 6px;
  }
  h1 { font-size: 16pt; line-height: 1.3; margin: 0 0 4px 0; }
  .subtitle { font-family: Helvetica, Arial, sans-serif; font-size: 9.5pt; color: #555; margin: 0 0 14px 0; }
  hr { border: none; border-top: 1px solid #d8d8d8; margin: 14px 0 18px 0; }
  p { margin: 0 0 10px 0; orphans: 3; widows: 3; }
  .tbl-wrap { margin: 4px 0 16px 0; page-break-inside: avoid; }
  .tbl-caption { font-family: Helvetica, Arial, sans-serif; font-weight: 700; font-size: 10pt; margin-bottom: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; }
  th, td { border: 1px solid #ccc; padding: 4px 7px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; font-family: Helvetica, Arial, sans-serif; font-weight: 700; }
  td.lead { font-weight: 700; }
  .tbl-footnotes { margin-top: 6px; font-size: 8.5pt; color: #555; }
  .tbl-footnotes p { margin: 0 0 3px 0; }
  .figures-heading {
    font-family: Helvetica, Arial, sans-serif; font-size: 12pt;
    margin: 22px 0 12px 0; padding-top: 14px; border-top: 1px solid #d8d8d8;
  }
  figure { margin: 0 0 18px 0; page-break-inside: avoid; }
  figure img { max-width: 100%; height: auto; display: block; border: 1px solid #ddd; }
  figcaption { font-family: Helvetica, Arial, sans-serif; font-size: 9pt; color: #555; margin-top: 4px; }
  footer {
    margin-top: 26px; padding-top: 10px; border-top: 1px solid #d8d8d8;
    font-family: Helvetica, Arial, sans-serif; font-size: 8.5pt; color: #777;
  }
</style></head>
<body>
  <div class="kind">${escapeHtml(reg.kindLabel)}</div>
  <h1>${escapeHtml(heading)}</h1>
  ${reg.subtitle ? `<p class="subtitle">${escapeHtml(reg.subtitle)}</p>` : ''}
  <hr/>
  ${bodyHtml}
  ${figuresHtml}
  <footer>
    Printed from FlyRegs on ${escapeHtml(printedOn)} · flyregs.com<br/>
    Always verify against the current official FAA source before operational use.
  </footer>
</body></html>`
}

// expo-print's native module is a single global slot -- a second
// printAsync() call while one is still in flight throws "Another print
// request is already in progress" instead of queuing. Every reg-detail
// screen's Print menu item has no busy-state guard of its own (confirmed:
// ac/far/aim/pcg/ad/loi all call this directly from an onPress with no
// debounce), so a double-tap -- exactly what a slow/janky UI thread
// produces -- threw this uncaught. Real device Sentry event, build 31,
// dist 31: "Another print request is already in progress" at
// expo-print/build/Print.js printAsync. Fixed once here since every call
// site shares this one function, not patched per-screen.
let inFlightPrint: Promise<void> | null = null

/** Opens the platform print dialog. Resolves once the dialog is dismissed;
 * a user cancelling is not an error. A second call while one is already
 * in flight reuses the same promise instead of racing the native module. */
export async function printReg(reg: PrintableReg): Promise<void> {
  if (inFlightPrint) return inFlightPrint
  inFlightPrint = doPrintReg(reg).finally(() => { inFlightPrint = null })
  return inFlightPrint
}

async function doPrintReg(reg: PrintableReg): Promise<void> {
  const html = await buildPrintHtml(reg)
  if (Platform.OS === 'web') {
    // expo-print's web path opens a print window already, but going through
    // it loses the document title on some browsers, so drive the iframe
    // directly and clean it up afterwards.
    const frame = document.createElement('iframe')
    frame.style.position = 'fixed'
    frame.style.right = '0'
    frame.style.bottom = '0'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    document.body.appendChild(frame)
    const doc = frame.contentDocument
    if (!doc) { document.body.removeChild(frame); return }
    doc.open(); doc.write(html); doc.close()
    await new Promise((r) => setTimeout(r, 250))
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    setTimeout(() => { try { document.body.removeChild(frame) } catch { /* already gone */ } }, 1000)
    return
  }
  await Print.printAsync({ html }).catch((err: any) => {
    // A user dismissing the system print sheet without tapping Print makes
    // UIPrintInteractionController's completion handler fire with
    // completed == false, which expo-print rejects as
    // PrintIncompleteException -- verified in the native source,
    // ExpoPrintWithPrinter.swift:94, whose reason string is exactly
    // "Printing did not complete" (ExpoPrintExceptions.swift:63).
    //
    // That is a CANCELLATION, not an error. All seven call sites
    // (ac/far/aim/pcg/ad/loi/cfr49) catch and Sentry.captureException, so
    // every cancelled print filed an exception -- burning quota and burying
    // the genuinely different PrintingJobFailedException, which is what a
    // real print failure raises. Swallowed once here rather than in seven
    // catch blocks, so those call sites now report only real failures.
    const msg = String(err?.message ?? err)
    if (/Printing did not complete/i.test(msg)) return
    throw err
  })
}
