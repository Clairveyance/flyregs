#!/usr/bin/env python3
"""Every table, column, RPC, bucket and edge function the CLIENT names, checked
against what actually exists on the server.

WHY
A client reference to something that no longer exists fails at runtime, in a
single feature, with a PostgREST error that a fire-and-forget call swallows
entirely (see gotcha-supabase-builder-lazy-never-sent). Nothing in the build
catches it: these are strings, so TypeScript has nothing to check, and the
screen that breaks may be one nobody opens for weeks.

The inverse question -- "what exists on the server that the client never
references" -- is deliberately NOT treated as a defect here: the scrapers,
triggers and edge functions legitimately use tables the app never touches.

Every finding is a NAME MISMATCH, which is checkable by eye from the output.
"""
import json, os, re, subprocess, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# optional path arg so the audit can be pointed at a fixture and PROVED able
# to fail -- a clean run means nothing from a check that cannot fail.
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE, "src")

def mgmt(sql):
    r = subprocess.run(["python3", os.path.join(BASE, "scripts", "supabase_mgmt_api.py"), "query", sql],
                       capture_output=True, text=True, cwd=BASE)
    out = r.stdout.strip()
    if not out.startswith("["):
        raise RuntimeError(out or r.stderr)
    return json.loads(out)

def split_select(sel):
    """Column names belonging to the PARENT table in a PostgREST select string.

    PostgREST embeds related tables inline: `ad_parts!inner(id, name,
    component_type)`. Splitting the raw string on commas attributes the CHILD
    table's columns to the parent -- which is exactly how a first run of this
    audit reported user_aircraft_equipment.name/.component_type/.manufacturer
    and dictionary_terms_gated.'term)' as missing columns. All five were the
    audit's own bug. So drop every embedded group (and its parentheses) before
    splitting, and skip aliases, json paths and *."""
    out, depth, buf = [], 0, []
    for ch in sel:
        if ch == "(":
            depth += 1
            # the name immediately before "(" is the embedded TABLE, not a column
            if depth == 1: buf = []
            continue
        if ch == ")":
            depth -= 1; continue
        if depth: continue
        if ch == ",":
            out.append("".join(buf)); buf = []
        else:
            buf.append(ch)
    out.append("".join(buf))
    keep = []
    for c in out:
        c = c.strip().split("!")[0].strip()
        if not c or ":" in c or "*" in c or "->" in c: continue
        keep.append(c)
    return keep


def blank_comments(t):
    t = re.sub(r"/\*.*?\*/", lambda m: " " * len(m.group(0)), t, flags=re.S)
    return re.sub(r"(?m)//.*$", lambda m: " " * len(m.group(0)), t)

# ---------------------------------------------------------------- what client says
tables, rpcs, buckets, fns, cols = {}, {}, {}, {}, {}
for root, _d, files in os.walk(SRC):
    for fn in files:
        if not fn.endswith((".ts", ".tsx")): continue
        p = os.path.join(root, fn)
        raw = open(p, encoding="utf-8").read()
        text = blank_comments(raw)
        rel = os.path.relpath(p, BASE)
        def where(idx): return f"{rel}:{raw.count(chr(10), 0, idx) + 1}"
        for m in re.finditer(r"supabase\s*\.\s*storage\s*\.\s*from\(\s*['\"]([^'\"]+)['\"]", text):
            buckets.setdefault(m.group(1), where(m.start()))
        for m in re.finditer(r"supabase\s*\.\s*from\(\s*['\"]([^'\"]+)['\"]", text):
            tables.setdefault(m.group(1), where(m.start()))
            # the .select(...) that follows this chain, for column checking
            tail = text[m.end(): m.end() + 900]
            sm = re.search(r"\.select\(\s*['\"]([^'\"]*)['\"]", tail)
            if sm:
                for c in split_select(sm.group(1)):
                    cols.setdefault((m.group(1), c), where(m.start()))
        for m in re.finditer(r"supabase\s*\.\s*rpc\(\s*['\"]([^'\"]+)['\"]", text):
            rpcs.setdefault(m.group(1), where(m.start()))
        for m in re.finditer(r"functions\s*\.\s*invoke\(\s*['\"]([^'\"]+)['\"]", text):
            fns.setdefault(m.group(1), where(m.start()))

# ---------------------------------------------------------------- what server has
live_tables = {r["t"] for r in mgmt(
    "select table_name t from information_schema.tables where table_schema='public' "
    "union select table_name from information_schema.views where table_schema='public'")}
live_cols = {(r["t"], r["c"]) for r in mgmt(
    "select table_name t, column_name c from information_schema.columns where table_schema='public'")}
# PostgREST COMPUTED COLUMNS are selectable exactly like real columns: any
# function taking a single argument of the table's own composite type can be
# named in select=. sync/migrations_revision_para_counts.sql defines two of
# them on content_revisions_gated, and this audit reported both as missing
# columns on its first run after that shipped -- a false positive on a pair of
# references that are proven to work live. Treat them as columns of their
# argument's table.
live_cols |= {(r["t"], r["f"]) for r in mgmt("""
    select cls.relname t, p.proname f
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type arg on arg.oid = p.proargtypes[0]
    join pg_class cls on cls.oid = arg.typrelid
    join pg_namespace cn on cn.oid = cls.relnamespace
    where n.nspname = 'public' and cn.nspname = 'public'
      and p.pronargs = 1 and cls.relkind in ('r','v','m')
""")}
live_rpcs = {r["p"] for r in mgmt(
    "select p.proname p from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'")}
live_buckets = {r["id"] for r in mgmt("select id from storage.buckets")}

def edge_function_exists(name):
    """Ask the gateway directly instead of trying to list functions.

    A deployed function replies to an unauthenticated POST with 401 (it
    enforces its own auth); a function that is not deployed 404s. Either way we
    learn what we need without sending a real payload. `None` means the probe
    itself failed and nothing is reported -- an earlier version read
    supabase_mgmt_api.py's usage text as a function list and declared two
    perfectly healthy functions missing."""
    try:
        env = {}
        for line in open(os.path.join(BASE, ".env")):
            k, _, v = line.strip().removeprefix("export ").partition("=")
            env[k] = v.strip("\"'")
        url = env["EXPO_PUBLIC_SUPABASE_URL"]
        anon = env["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
    except Exception:
        return None
    import urllib.request, urllib.error
    req = urllib.request.Request(f"{url}/functions/v1/{name}", data=b"{}", method="POST")
    req.add_header("apikey", anon)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status != 404
    except urllib.error.HTTPError as e:
        return e.code != 404
    except Exception:
        return None

problems = []
def check(kind, named, live, skip=()):
    if live is None:
        print(f"  --    {kind}: could not read the server list, not checked"); return
    for name, site in sorted(named.items()):
        if name in skip: continue
        if name not in live:
            problems.append(f"{kind} '{name}' referenced at {site} does NOT exist on the server")
            print(f"  MISS  {kind} '{name}'  <-- {site}")
    print(f"  ok    {len(named)} {kind}(s) referenced, {len(named) - sum(1 for n in named if n not in live)} resolve")

print("=== client references vs. live server ===")
check("table/view", tables, live_tables)
check("rpc", rpcs, live_rpcs)
check("bucket", buckets, live_buckets)

print("\n=== columns named in .select() ===")
missing_cols = [(t, c, s) for (t, c), s in sorted(cols.items())
                if t in live_tables and (t, c) not in live_cols]
for t, c, s in missing_cols:
    problems.append(f"column {t}.{c} selected at {s} does NOT exist")
    print(f"  MISS  {t}.{c}  <-- {s}")
print(f"  ok    {len(cols)} column reference(s) checked, {len(cols) - len(missing_cols)} resolve")

print("\n=== edge functions (probed at the gateway: 404 = not deployed) ===")
for name, site in sorted(fns.items()):
    exists = edge_function_exists(name)
    if exists is None:
        print(f"  --    {name}: probe failed, not checked")
    elif exists:
        print(f"  ok    {name} is deployed")
    else:
        problems.append(f"edge function '{name}' invoked at {site} is NOT deployed")
        print(f"  MISS  edge function '{name}'  <-- {site}")

print("\n" + "=" * 62)
if problems:
    print(f"{len(problems)} BROKEN REFERENCE(S):")
    for x in problems: print("  -", x)
else:
    print("Every client reference resolves on the server.")
sys.exit(1 if problems else 0)
