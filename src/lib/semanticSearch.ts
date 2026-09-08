import { supabase, isEdgeFunctionTimeout } from '@/lib/supabase'
import type { RegType } from '@/lib/regTypes'

// "Ask FlyRegs" -- natural-language / conceptual search, distinct from the
// existing SmartSearch on Home (lexical + curated-bridge + morphology, see
// smartsearch_architecture memory, which deliberately did NOT add
// query-time vector search). This is that missing piece: content_chunks +
// pgvector, embedded corpus-wide by sync/build_embeddings.py (task #114's
// data half, already done), queried through the `semantic-search` Edge
// Function (this file's own counterpart) since embedding a query requires
// a real OpenAI API call with a secret key the client can never hold.
//
// Deliberately submit-triggered, not debounced-as-you-type like every
// other search box in this app -- unlike a free Postgres ILIKE query, each
// call here costs a real (tiny, ~$0.00001) OpenAI request, so firing one
// per keystroke would be wasteful for no benefit (a half-typed question
// isn't a meaningful embedding anyway).

export interface SemanticSearchResult {
  sourceType: RegType
  sourceId: string
  title: string
  chunkText: string
  similarity: number
}

// 18s -- the most aggressive of this app's three invoke() timeouts (see
// lib/supabase.ts's isEdgeFunctionTimeout comment for why all three needed
// one). This is a read-only lookup the user is actively watching a spinner
// for, not a background sync or a destructive server-side operation, so it
// should give up and let them retry sooner than the other two.
const SEMANTIC_SEARCH_TIMEOUT_MS = 18000

export async function semanticSearch(query: string, contentTypes?: RegType[]): Promise<SemanticSearchResult[]> {
  const trimmed = query.trim()
  if (trimmed.length < 3) return []
  const { data, error } = await supabase.functions.invoke('semantic-search', {
    method: 'POST',
    body: { query: trimmed, contentTypes: contentTypes && contentTypes.length > 0 ? contentTypes : undefined },
    timeout: SEMANTIC_SEARCH_TIMEOUT_MS,
  })
  if (error) {
    // semantic-search.tsx renders err.message inline as the screen's error
    // state, so whatever comes out of here is what the user reads.
    //
    // This used to humanize ONLY the timeout and rethrow everything else --
    // which meant every other fetch failure (offline, DNS, TLS, a dropped
    // connection mid-request) put invoke()'s raw
    // "Failed to send a request to the Edge Function" on screen. RC hit
    // exactly that on B40 2026-09-08 and reported it as "the page wouldn't
    // even load properly": a string that names an implementation detail,
    // suggests nothing to do about it, and looks like the app is broken even
    // when the edge function is healthy (it was -- the same query returned 15
    // results 40 minutes later).
    if (isEdgeFunctionTimeout(error)) {
      throw new Error('Search timed out. Check your connection and try again.')
    }
    // Any other FunctionsFetchError is a transport failure: the request never
    // got an answer. Nothing about the query is wrong, so say so and point at
    // the one thing the user can actually change.
    if (error?.name === 'FunctionsFetchError') {
      throw new Error("Couldn't reach search. Check your connection and try again.")
    }
    // A non-2xx from the function itself -- the server was reached and said no.
    if (error?.name === 'FunctionsHttpError') {
      throw new Error('Search is temporarily unavailable. Please try again in a moment.')
    }
    throw error
  }
  if (data?.error) throw new Error(data.error)
  return ((data?.results ?? []) as any[]).map((r) => ({
    sourceType: r.source_type,
    sourceId: r.source_id,
    title: r.title,
    chunkText: r.chunk_text,
    similarity: r.similarity,
  }))
}
