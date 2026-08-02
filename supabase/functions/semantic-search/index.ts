// "Ask FlyRegs" -- natural-language semantic search over content_chunks
// (task #114's missing query UI half; the embeddings themselves have been
// built and maintained by sync/build_embeddings.py since 2026-07-30). A
// query's own embedding can't be computed client-side or on a public
// endpoint -- it needs the OpenAI API key, which must stay server-side --
// so this function does exactly three things: authenticate the caller,
// embed their query text with the SAME model used to build content_chunks
// (any mismatch would put the query vector in a different space, making
// every cosine-distance comparison meaningless), then call the
// `semantic_search` Postgres RPC (pgvector, already deployed) with that
// vector and return the results.
//
// No third-party imports -- plain fetch to GoTrue/PostgREST/OpenAI, same
// convention as delete-account/revenuecat-webhook (confirmed live: `jsr:`
// and `esm.sh` remote imports both caused BOOT_ERROR when deployed via the
// Management API's single-file endpoint, the only deploy path available
// with no Supabase CLI installed).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const EMBEDDING_MODEL = 'text-embedding-3-small'
const MIN_QUERY_LEN = 3
const MAX_QUERY_LEN = 500
const DEFAULT_MATCH_COUNT = 15
const MAX_MATCH_COUNT = 30
// A single document can have multiple chunks rank highly (a long AC split
// across several ~3000-char pieces) -- without this, "weight and balance"
// could return the same AC three times before a second document ever
// appears. Cap how many of the top-N raw chunk matches get scanned for
// per-document dedup so one very-relevant document can't crowd out
// everything else; the real fix is asking Postgres for more than the
// client-facing result count and trimming here.
// Widened from 3 to 8, 2026-08-02: several broad conceptual queries had
// their genuinely best-matching FAR/AIM/PCG/AC document sitting just
// outside the raw candidate window entirely -- e.g. AC 90-120 (literally
// titled "Operational Use of Airborne Collision Avoidance Systems") never
// appeared for "what guidance exists on installing airborne collision
// avoidance systems?" even after the AD priority discount below, because
// it wasn't in the top matchCount*3 raw pgvector matches to begin with.
// A wider raw pool costs nothing extra (pgvector KNN over 46K rows is
// effectively free regardless of LIMIT) and gives the priority discount
// and per-document dedup more real candidates to actually choose from.
const RAW_FETCH_MULTIPLIER = 8

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const authHeader = req.headers.get('authorization')
  if (!authHeader) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const openaiKey = Deno.env.get('OPENAI_API_KEY')

  if (!openaiKey) {
    console.error('OPENAI_API_KEY not configured for semantic-search function')
    return jsonResponse({ error: 'Search is temporarily unavailable.' }, 500)
  }

  // Never trust a client-supplied identity for a feature that spends real
  // money per call -- resolve the caller from their own session token,
  // same pattern as delete-account.
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: authHeader },
  })
  if (!userRes.ok) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  let body: { query?: string; contentTypes?: string[]; matchCount?: number }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400)
  }

  const query = (body.query ?? '').trim()
  if (query.length < MIN_QUERY_LEN) {
    return jsonResponse({ error: 'Query too short' }, 400)
  }
  if (query.length > MAX_QUERY_LEN) {
    return jsonResponse({ error: 'Query too long' }, 400)
  }

  const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: query }),
  })
  if (!embedRes.ok) {
    console.error('OpenAI embeddings error', embedRes.status, await embedRes.text())
    return jsonResponse({ error: 'Search is temporarily unavailable.' }, 502)
  }
  const embedJson = await embedRes.json()
  const embedding: number[] = embedJson?.data?.[0]?.embedding
  if (!Array.isArray(embedding)) {
    console.error('Unexpected OpenAI embeddings response shape', JSON.stringify(embedJson).slice(0, 300))
    return jsonResponse({ error: 'Search is temporarily unavailable.' }, 502)
  }

  const matchCount = Math.min(Math.max(Math.trunc(body.matchCount ?? DEFAULT_MATCH_COUNT), 1), MAX_MATCH_COUNT)
  const contentTypes = Array.isArray(body.contentTypes) && body.contentTypes.length > 0 ? body.contentTypes : null

  const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/semantic_search`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_query_embedding: `[${embedding.join(',')}]`,
      p_content_types: contentTypes,
      p_match_count: matchCount * RAW_FETCH_MULTIPLIER,
    }),
  })
  if (!rpcRes.ok) {
    console.error('semantic_search RPC error', rpcRes.status, await rpcRes.text())
    return jsonResponse({ error: 'Search failed.' }, 500)
  }
  const rawResults: Array<{
    source_type: string
    source_id: string
    chunk_index: number
    title: string
    chunk_text: string
    similarity: number
  }> = await rpcRes.json()

  // Dedup to one (best) chunk per real document, preserving similarity
  // order -- see RAW_FETCH_MULTIPLIER's own comment. Not yet trimmed to
  // matchCount -- the priority re-rank below needs the full deduped set
  // to work with before the final cut.
  const seen = new Set<string>()
  const deduped: typeof rawResults = []
  for (const r of rawResults) {
    const key = `${r.source_type}::${r.source_id}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(r)
  }

  // RC: "the majority of AFR query material will come from FAR, AIM, P/CG,
  // ACs. The ADs and LOIs do need to be included... but hardly the
  // priority result in most cases." Found live: broad conceptual queries
  // returned only AD results at mediocre similarity (0.40-0.57), crowding
  // out real FAR/AIM/PCG/AC matches in the same range -- AD's sheer volume
  // (15,983 of 46,270 chunks corpus-wide) statistically wins slots in the
  // shared embedding space regardless of topical fit. A flat discount
  // (not a hard partition) so a genuinely dominant AD/LOI match -- "AD for
  // Lycoming crankshafts" scored 0.713, far above anything else for that
  // query -- still wins outright, while a borderline one drops back below
  // the FAR/AIM/PCG/AC match it was crowding out. Applied only for
  // ranking; `similarity` shown to the client stays the real score.
  const DEPRIORITIZED_TYPES = new Set(['ad', 'loi'])
  const RANK_DISCOUNT = 0.08
  const reranked = deduped
    .map((r) => ({ r, rankScore: r.similarity - (DEPRIORITIZED_TYPES.has(r.source_type) ? RANK_DISCOUNT : 0) }))
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, matchCount)
    .map((x) => x.r)

  return jsonResponse({ results: reranked })
})
