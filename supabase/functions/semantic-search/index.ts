// "Ask FlyRegs" -- natural-language semantic search over content_chunks
// (task #114's missing query UI half; the embeddings themselves have been
// built and maintained by sync/build_embeddings.py since 2026-07-30). A
// query's own embedding can't be computed client-side or on a public
// endpoint -- it needs the OpenAI API key, which must stay server-side --
// so this function does exactly three things: authenticate the caller,
// embed their query text with the SAME model used to build content_chunks
// (any mismatch would put the query vector in a different space, making
// every cosine-distance comparison meaningless), then call the
// `hybrid_search` Postgres RPC with that vector AND the raw query text,
// and return the results.
//
// Switched from `semantic_search` (pure pgvector) 2026-08-04, task #64 --
// confirmed live that pure cosine similarity fails bare citation lookups
// ("61.87" surfaced an unrelated AC's turbine-engine data table instead of
// FAR § 61.87 itself). `hybrid_search` fuses vector + full-text + an
// exact-citation boost via Reciprocal Rank Fusion; see
// sync/migrations_hybrid_search.sql for the full fix writeup. Everything
// below this RPC call -- dedup, AD/LOI rank discount -- is unchanged.
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

  // Ask FlyRegs is a Pro feature, and until 2026-08-05 that was enforced
  // ONLY in the client (semantic-search.tsx's hasProAccess check). Having a
  // session was the whole bar here, so any signed-in FREE account could call
  // this endpoint directly and get results -- confirmed live against
  // production during the pre-beta gating audit: 3 results, 2,424 characters
  // of chunk_text, on a brand-new free account.
  //
  // Two separate things were wrong with that: the feature itself is paid,
  // and `content_chunks` carries the body text of paid AC/AD/LOI documents
  // (that table is correctly RLS-denied to anon/authenticated -- this
  // function reads it with the service role, which is exactly why the check
  // has to happen HERE).
  //
  // has_pro_access() is the same DB function the gated views use, so there
  // is one definition of "Pro" server-side rather than a second copy that
  // can drift. It fails CLOSED on a missing entitlement row, matching the
  // content gates.
  const { id: callerId } = await userRes.json()
  const tierRes = await fetch(
    `${supabaseUrl}/rest/v1/rpc/has_pro_access`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_user_id: callerId }),
    }
  )
  if (!tierRes.ok) {
    console.error('semantic-search: tier check failed', tierRes.status, await tierRes.text())
    return jsonResponse({ error: 'Search is temporarily unavailable.' }, 500)
  }
  if ((await tierRes.json()) !== true) {
    return jsonResponse({ error: 'Ask FlyRegs requires a Pro subscription.' }, 403)
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

  // One retry on a transient RPC failure -- found live 2026-08-09 via
  // semantic_search_breadth_test.py's real-account breadth run: 2 of 25
  // otherwise-fine queries ("can I fly drunk", "what happens if my radio
  // dies in the clouds") hard-failed with a bare "Search failed." 500.
  // Re-ran both directly afterward (repeatedly, and a full fresh 25-query
  // pass) and neither reproduced -- both come back in ~1s every time, nowhere
  // near hybrid_search's own known statement-timeout failure mode (see
  // migrations_hybrid_search.sql's v6/v7 writeup, which needs several
  // SECONDS of slow lexical fallback to trip, not this). Everything points
  // to a one-off transient blip (DB briefly under load from something else
  // that Sunday morning) rather than a deterministic per-query bug -- but
  // a paid Pro feature hard-failing a real user's question on any transient
  // hiccup, with zero recovery, is exactly what shouldn't happen for a
  // regulatory-reference app. One retry costs nothing on the normal path
  // and turns a random one-off blip into an invisible ~1s of extra latency
  // instead of a dead-end error screen.
  const callHybridSearch = () =>
    fetch(`${supabaseUrl}/rest/v1/rpc/hybrid_search`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_query_embedding: `[${embedding.join(',')}]`,
        p_query_text: query,
        p_content_types: contentTypes,
        p_match_count: matchCount * RAW_FETCH_MULTIPLIER,
      }),
    })

  let rpcRes: Response
  let rpcErrText = ''
  try {
    rpcRes = await callHybridSearch()
    if (!rpcRes.ok) rpcErrText = await rpcRes.text()
  } catch (err) {
    rpcRes = new Response(null, { status: 0 })
    rpcErrText = String(err)
  }
  if (!rpcRes.ok) {
    console.error('hybrid_search RPC error (attempt 1)', rpcRes.status, rpcErrText)
    try {
      rpcRes = await callHybridSearch()
      if (!rpcRes.ok) rpcErrText = await rpcRes.text()
    } catch (err) {
      rpcRes = new Response(null, { status: 0 })
      rpcErrText = String(err)
    }
  }
  if (!rpcRes.ok) {
    console.error('hybrid_search RPC error (attempt 2, giving up)', rpcRes.status, rpcErrText)
    return jsonResponse({ error: 'Search failed.' }, 500)
  }
  const rawResults: Array<{
    source_type: string
    source_id: string
    chunk_index: number
    title: string
    chunk_text: string
    similarity: number
    rrf_score: number
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
  //
  // Ranks by rrf_score now, not `similarity` -- 2026-08-04 bug found live
  // during the hybrid_search switchover: sorting by raw similarity here
  // silently discarded the RPC's own fused ranking (vector + lexical +
  // citation boost), so a bare citation query like "61.87" still surfaced
  // an unrelated AC first, because FAR 61.87's real cosine similarity
  // (0.20) is much lower than a document that merely LOOKS similar in
  // embedding space (0.41) -- the entire point of hybrid_search is that
  // rrf_score, not similarity, is the correct ranking signal. The AD/LOI
  // discount also moved from an additive subtraction (calibrated for
  // similarity's 0-1 range) to a proportional multiplier, since rrf_score
  // has no fixed range (~0.003-0.033 for a normal fused match, but 1.0+
  // when the citation boost fires) -- a flat subtraction would either do
  // nothing against a citation-boosted score or blot out every non-boosted
  // one entirely, depending on scale, whereas a proportional cut keeps the
  // same "genuinely dominant wins outright, borderline gets pushed down"
  // behavior at any score magnitude.
  // ── Rerank (2026-08-05) ──────────────────────────────────────────────
  // Measured with scripts/search_eval.py, which scores three query kinds
  // SEPARATELY -- that split is the whole point, and it caught a change that
  // looked like a win in aggregate while badly regressing the most important
  // case. Baseline before this block: R@1 lexical 0.60 / conceptual 0.00.
  //
  // Conceptual R@1 was ZERO: not one natural-language pilot question ("what
  // paperwork does a mechanic complete after a repair") returned the right
  // document first, even though Recall@30 is 18/18 -- the correct answer was
  // in the candidate pool EVERY time. So this is purely a ranking problem,
  // not a retrieval one. What kept winning those top slots was Advisory
  // Circulars: an AC is long, prose-heavy and written in natural language,
  // so it out-matches the terse authoritative FAR/AIM text it exists to
  // explain, on both vector and lexical signals at once.
  //
  // Three things are combined here, and one deliberately is NOT:
  //
  // 1. Similarity MAGNITUDE, not just RRF rank position. Reciprocal-rank
  //    fusion deliberately throws away score magnitude, which is what let a
  //    generically-titled legal interpretation (similarity 0.632) outrank
  //    two near-verbatim title matches (0.783 and 0.724) on the query "basic
  //    VFR weather minimums cloud clearance" -- mediocre-but-present in both
  //    the vector and lexical lists beat excellent-in-one.
  // 2. Fused position, retained at half weight so the RPC's own lexical +
  //    citation evidence still counts for something.
  // 3. A primary-source prior. RC's own framing: FAR/AIM/P-CG/AC are the
  //    query material, "ADs and LOIs... hardly the priority result in most
  //    cases." AC now gets a milder step-down than AD/LOI -- an AC is
  //    genuinely useful, but for a regulatory reference app the rule itself
  //    should outrank the circular explaining it. This single change was the
  //    largest measured win, and it helped BOTH subsets (nothing here is a
  //    trade of conceptual quality for lexical).
  //
  // NOT included: any title-match signal. Tested TWO independent ways, both
  // rejected on measurement:
  //   - lexical title-word overlap: lexical R@1 0.60 -> 0.80, but conceptual
  //     MRR 0.31 -> 0.22.
  //   - SEMANTIC title similarity (title embedded alone, so the ~3000-char
  //     body can't dilute it, then cosine against the query): lexical R@1
  //     0.90 -> 1.00, but conceptual R@1 0.25 -> 0.12.
  // The first was assumed to fail because of vocabulary mismatch; the second
  // has no such weakness and failed the SAME way, so the real finding is
  // more general: a title signal amplifies whichever document's title most
  // resembles the query, and for a natural-language question that is
  // systematically NOT the document that answers it (FAR 43.9, "Content,
  // form, and disposition of maintenance... records", is the answer to "what
  // paperwork does a mechanic complete after a repair" while some AC about
  // repair stations looks far more like the question).
  // Lexical queries already sit at 0.90 R@1 here, so buying 0.90 -> 1.00
  // there by cutting conceptual 0.25 -> 0.12 is a bad trade -- natural
  // language is the flagship case ("Ask FlyRegs"), not the edge case.
  // Aggregate-only scoring would have shown the first variant as R@1
  // 0.33 -> 0.44 and read as a clean win. Don't re-add either without
  // re-running the split-subset eval.
  // 'dictionary' is mnemonics ONLY (see sync/build_embeddings.py's
  // SOURCE_TYPE_OVERRIDE -- no other dictionary_terms category gets
  // embedded), and they were built specifically so a matching mnemonic
  // shows up as a natural-language answer (task #63) -- but a mnemonic's
  // embedded text is short (a term + its letter breakdown), so it
  // structurally scores a lower raw cosine similarity than a full FAR/AIM
  // paragraph even when topically dead-on. Confirmed live 2026-08-06: RC's
  // real query "how do i know which ifr route to fly with lost comms" is a
  // textbook match for the AVE-F mnemonic (FAR 91.185(c)(1)'s own route
  // options), but AVE-F's similarity (0.423) sat just below the top-15 cut
  // (~0.47) even after the ef_search recall fix (see
  // migrations_hybrid_search.sql) made it a genuine candidate at all. A
  // modest boost -- mirroring the AD/LOI/AC discount in the other
  // direction, same mechanism -- so a mnemonic that's actually in the
  // running gets pulled into the visible list instead of losing on a
  // structural length disadvantage. Not a guaranteed #1: the regulatory
  // text itself should still usually outrank the mnemonic that summarizes
  // it (see [[feedback_data_is_king]]) -- this only helps a mnemonic clear
  // the cutoff when it's genuinely a close match.
  const PRIMARY_SOURCE_PRIOR: Record<string, number> = { ad: 0.85, loi: 0.85, ac: 0.80, dictionary: 1.15 }
  const W_SIMILARITY = 1.0
  const W_FUSED_POSITION = 0.5

  // An exact source_id match contributes a flat 1.0 to rrf_score in
  // hybrid_search, ~30-300x a normal fused score (~0.003-0.033). That boost
  // is the fix for a real bug: a bare "61.87" surfaced an unrelated AC first,
  // because FAR 61.87's true cosine similarity is only ~0.20 while a merely
  // similar-LOOKING document scored 0.41. Blending similarity back in would
  // silently undo it -- by arithmetic, not by intent -- so a citation hit is
  // PINNED above the blended range rather than left to weight tuning. Guarded
  // by the 'citation' cases in scripts/search_eval.py; those exist to fail
  // loudly if this is ever refactored away.
  const CITATION_RRF_FLOOR = 0.5
  const CITATION_PIN = 1000

  const n = deduped.length
  const reranked = deduped
    .map((r, i) => {
      const fusedPosition = n > 1 ? 1 - i / (n - 1) : 1
      const blended =
        (W_SIMILARITY * r.similarity + W_FUSED_POSITION * fusedPosition) *
        (PRIMARY_SOURCE_PRIOR[r.source_type] ?? 1)
      const rankScore =
        r.rrf_score >= CITATION_RRF_FLOOR ? CITATION_PIN + r.similarity : blended
      return { r, rankScore }
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, matchCount)
    // rrf_score is an internal ranking signal, not part of the client contract -- drop it here
    // rather than leaking hybrid_search's implementation details into the API response.
    .map(({ r: { rrf_score: _rrf_score, ...rest } }) => rest)

  return jsonResponse({ results: reranked })
})
