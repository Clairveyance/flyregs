"""Shadow evaluator for search_far's ranking. Changes NOTHING in production.

It inlines search_far's exact scoring expression as a plain query with the
weights parameterised, so a candidate weighting can be measured over hundreds of
real queries before the live function is touched. With the default weights it
reproduces production byte-for-byte (w_sub=0), which is the control that proves
the harness is measuring the real thing.

Deliberately does NOT go through the RPC: search_far clamps non-Plus callers to
10 results via has_plus_access(), and the Management API has no session, so
calling the RPC here would silently measure the free-tier depth instead of the
ranking. Measured at full depth; tier depth is a separate concern.
"""
import sys, math
sys.path.insert(0, "scripts")
from author_fact_deck import mgmt_sql
from search_eval_cases import FAR_CASES

SCORE = """
      coalesce(2000 + an.best_len * 10, 0)
      + case when c.norm_title = q.phrase then 1000 else 0 end
      + case when c.norm_title like '%' || q.phrase || '%' then 300 else 0 end
      + case when length(c.norm_title) >= 6
                  and length(c.norm_title)::numeric / greatest(length(q.phrase),1) >= 0.6
                  and search_phrase_contains(q.phrase, c.norm_title)
             then 260 else 0 end
      + (search_term_hits(c.title, q.rphrase)::numeric / q.n_terms) * {w_title}
      + ((search_term_hits(c.title || ' ' || coalesce(c.subpart_title,''), q.rphrase)
          - search_term_hits(c.title, q.rphrase))::numeric / q.n_terms) * {w_sub}
      + ((select count(*) from unnest(tsvector_to_array(to_tsvector('english', q.rphrase))) as t(term)
          where t.term = any(tsvector_to_array(c.search_vector)))::numeric / q.n_terms) * {w_doc}
      + case when q.bigrams is not null and exists (
             select 1 from unnest(q.bigrams) as bg
             where position(bg in lower(coalesce(c.subpart_title,''))) > 0)
             then {w_subphrase} else 0 end
      + case when q.bigrams is not null and exists (
             select 1 from unnest(q.bigrams) as bg
             where position(bg in lower(coalesce(c.title,''))) > 0)
             then {w_titlephrase} else 0 end
      + case when c.search_vector @@ q.and_q then {w_and} else 0 end
      + case when lower(coalesce(c.body_text,'')) like '%' || q.phrase || '%' then 40 else 0 end
      + ts_rank(c.search_vector, q.or_q) * {w_ts}
      + ln(1 + c.citation_count) * 5
      + ln(1 + c.search_popularity) * 5
"""

def build_sql(chunk, w):
    cases = ",".join(f"({i},{q!r})".replace('"', "'") for i, (q, _) in chunk)
    exps  = ",".join(f"({i},'{s}')" for i, (_, e) in chunk for s in e)
    return f"""
with cases(cid, qtext) as (values {cases}),
exp(cid, sec) as (values {exps}),
rq as (select cid, qtext, coalesce(nullif(search_resolve_query(qtext),''), qtext) as resolved from cases),
lex as (select rq.cid, (m)[1] as clean from rq, regexp_matches(to_tsvector('english', rq.resolved)::text, $$'([^']+)'$$, 'g') as m
        group by rq.cid, (m)[1]),
q as (select rq.cid,
        plainto_tsquery('english', rq.resolved) as and_q,
        (select to_tsquery('english', string_agg(clean || ':*', ' | ')) from lex where lex.cid = rq.cid) as or_q,
        btrim(regexp_replace(lower(rq.qtext), '\\s+', ' ', 'g')) as phrase,
        btrim(regexp_replace(lower(rq.resolved), '\\s+', ' ', 'g')) as rphrase,
        search_term_count(rq.resolved) as n_terms,
        (select array_agg(a[i] || ' ' || a[i+1])
           from (select regexp_split_to_array(btrim(regexp_replace(lower(rq.resolved),'\\s+',' ','g')),' ') as a) z,
                generate_subscripts(z.a,1) as i
          where i < array_length(z.a,1)) as bigrams
      from rq),
anchors as (select q.cid, a.doc_id,
        max(case when a.phrase = q.phrase then length(a.phrase)+10000 else length(a.phrase) end) as best_len
      from search_concept_anchors a, q
      where a.doc_type='far'
        and (search_anchor_matches(q.phrase,a.phrase) or search_anchor_matches(q.rphrase,a.phrase)
             or (length(q.phrase)>=3 and search_phrase_contains(a.phrase,q.phrase)))
      group by q.cid, a.doc_id),
matched as (select q.cid, f.section_number, f.subpart_title, f.title, f.body_text, f.search_vector,
        f.citation_count, f.search_popularity, search_norm_title(f.title) as norm_title
      from far_sections f, q where f.search_vector @@ q.or_q),
anchor_only as (select an.cid, f.section_number, f.subpart_title, f.title, f.body_text, f.search_vector,
        f.citation_count, f.search_popularity, search_norm_title(f.title) as norm_title
      from far_sections f join anchors an on an.doc_id=f.section_number
      where not exists (select 1 from matched m where m.section_number=f.section_number and m.cid=an.cid)),
combined as (select * from matched union all select * from anchor_only),
scored as (select c.cid, c.section_number, ({SCORE.format(**w)})::real as out_rank
      from combined c join q on q.cid=c.cid
      left join anchors an on an.cid=c.cid and an.doc_id=c.section_number),
ranked as (select cid, section_number, row_number() over (partition by cid order by out_rank desc, section_number) as rn from scored)
select cs.cid, min(r.rn) as best_rank
from cases cs left join exp e on e.cid=cs.cid
  left join ranked r on r.cid=cs.cid and r.section_number=e.sec
group by cs.cid order by cs.cid
"""

def evaluate(weights, cases=FAR_CASES, k=10, chunk_size=40, verbose=False):
    w = {"w_title":180, "w_sub":0, "w_doc":0, "w_subphrase":0, "w_titlephrase":0, "w_and":60, "w_ts":20}; w.update(weights)
    items = list(enumerate(cases))
    ranks = {}
    for i in range(0, len(items), chunk_size):
        for r in mgmt_sql(build_sql(items[i:i+chunk_size], w)):
            ranks[r["cid"]] = r["best_rank"]
    hits = sum(1 for c in ranks.values() if c and c <= k)
    mrr  = sum(1.0/c for c in ranks.values() if c) / len(ranks)
    if verbose:
        for i,(qt,ex) in items:
            br = ranks.get(i)
            if not br or br > k: print(f"   MISS rank={br}  {qt!r} -> {ex}")
    return hits, len(ranks), mrr, ranks

if __name__ == "__main__":
    hits, n, mrr, _ = evaluate({})
    print(f"CONTROL (production weights, w_sub=0): recall@10 = {hits}/{n} = {hits/n*100:.1f}%   MRR={mrr:.3f}")
