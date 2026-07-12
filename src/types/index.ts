export interface AdvisoryCircular {
  id: string
  document_number: string
  title: string
  date_issued: string | null
  office: string | null
  subject_series: string | null
  description: string | null
  pdf_text: string | null
  pdf_blocks: import('@/lib/acFormat').ACBlock[] | null
  pdf_url_cached: string | null
  pdf_url_faa: string | null
  change_number: number
  status: 'active' | 'cancelled' | 'inactive'
  cancels: string[]
  document_id: number | null
  updated_at: string
  // Indices into pdf_blocks that changed in the most recent revision (null if
  // no diff is available yet — see migrations/add_changed_block_indices.sql)
  changed_block_indices: number[] | null
  // Client-side join only — not a DB column
  related_lois?: LetterOfInterpretation[]
}

export interface AcFigure {
  id: string
  label: string          // e.g. "Figure C-6", "Table 3-1"
  caption: string | null
  page: number
  image_url: string
}

// A page flagged as containing a formula/equation too complex or structurally
// lost (nested fractions, summations, trig functions) for our OCR/parser
// pipeline to reliably reproduce as text -- lets a reader jump straight to
// the real page image instead of trusting a possibly-wrong transcription.
// Populated manually (scripts/add_formula_ref.py), never auto-scraped -- see
// flyregs_parser.md's "Zero-text ACs" section for why this can't be a
// reliable heuristic. Deliberately a separate table/pipeline from ac_figures
// (Figures & Tables) so this never risks the existing T&F extraction logic.
export interface FormulaRef {
  id: string
  label: string          // e.g. "Reynolds number correction (A3-1.4)"
  note: string | null    // why it's flagged, e.g. "log-ratio of nested fractions"
  page: number
  image_url: string
}

export interface ACSeries {
  id: string
  series_prefix: string
  display_name: string
  description: string | null
  audience: string[]
  sort_order: number
  ac_count: number
}

export interface SearchResult {
  id: string
  document_number: string
  title: string
  date_issued: string | null
  office: string | null
  subject_series: string | null
  description: string | null
  pdf_url_cached: string | null
  rank: number
}

export interface LetterOfInterpretation {
  id: string
  loi_id: string
  title: string
  date_issued: string | null
  requestor: string | null
  pdf_url_faa: string | null
  pdf_text: string | null
  pdf_blocks: import('@/lib/acFormat').ACBlock[] | null
  pdf_blocks_version: number
  referenced_cfr_parts: string[]
  status: 'active' | string
  updated_at: string
}

export interface LOIACReference {
  loi_id: string
  ac_id: string
  relevance: 'primary' | 'related' | null
  created_at: string
}

export interface UserBookmark {
  id: string
  ac_id: string
  note: string | null
  created_at: string
  advisory_circulars: Pick<AdvisoryCircular, 'id' | 'document_number' | 'title' | 'date_issued' | 'office' | 'subject_series'>
}
