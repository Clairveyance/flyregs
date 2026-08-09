import * as Print from 'expo-print'
import { Platform } from 'react-native'
import { normalizeRegBody } from '@/lib/regTextFormat'

// "Print & export any section" is sold as a PLUS feature, but until now the
// app had no print at all — the only thing behind that promise was the OS
// share sheet, which exports a LINK, not the text. This is the print half.
//
// Renders the regulation to a clean, paper-shaped HTML document and hands it
// to the platform print dialog (AirPrint / system print on native, the
// browser print dialog on web). Deliberately NOT a screenshot of the app UI:
// a printed reg should read like a document — serif body, real margins, no
// dark theme burning half a toner cartridge.

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
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Body text -> paragraphs. Uses the same normalizer the reg screens render
 * with, so the printout matches what the user saw rather than re-deriving
 * its own spacing rules. */
function bodyToHtml(body: string): string {
  const normalized = normalizeRegBody(body ?? '')
  return normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n')
}

export function buildPrintHtml(reg: PrintableReg): string {
  const heading = [reg.documentNumber, reg.title].filter(Boolean).join(' — ')
  const printedOn = new Date().toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  })
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
  ${bodyToHtml(reg.body)}
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
  const html = buildPrintHtml(reg)
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
  await Print.printAsync({ html })
}
