#!/usr/bin/env python3
"""A read-only get_* RPC must return EMPTY for something you can't see, not raise.

WHY THIS EXISTS
RC, 2026-09-16: "figure out that 400 error and fix it."

`get_folder_collaborators` gated on owning the `synced_folders` row and raised
'Not authorized' otherwise. A COLLABORATOR never owns one -- verified against
live data, `collab_has_own_row` was false for every row in
folder_collaborators -- and `folder/[id].tsx` called it on every load, ungated,
believing (in its own comment) that it "just returns an empty list". So opening
a folder shared with you produced a 400. Every time. Same for a folder deleted
server-side, and for a new folder opened before its local-first sync push lands.

None of it was visible: the call sites are `.catch(() => setCollaborators([]))`.

CHECKED, not assumed: this did NOT reach Sentry. `sentry.ts` sets
`enableCaptureFailedRequests: true` but leaves `failedRequestStatusCodes` at the
SDK default of `[[500, 599]]`, so 4xx is excluded -- and the Sentry issue list
has no such issue. The cost today is a wasted round trip and a genuine server
error raised on a completely ordinary action. The cost tomorrow is larger: the
moment anyone widens that range to cover 4xx -- which is the obvious next step,
since supabase-js failures are overwhelmingly 4xx -- every one of these turns
into a reported failure, with a screenshot attached.

THE RULE, and it is narrower than "reads must never raise"
The defect is a MISMATCH: the server raises for a case the CLIENT has already
decided is unremarkable. `.catch(() => setCollaborators([]))` is the client
saying "this failing is normal and I will carry on" -- and a hard HTTP error for
something normal is exactly what Sentry is configured to report.

Where the client SURFACES the error, a raise is doing real work and is correct.
`get_challenge_results` / `get_challenge_standings` also raise ("Challenge not
found"), and this audit deliberately does NOT flag them: challenges/[id].tsx
awaits them inside a try/catch that sets a visible error screen
(`setLoadError(...)`, `setPhase('error')`). That message is the whole point of
the raise. The first draft of this audit flagged them anyway, which would have
pushed a real error state toward silently rendering an empty results screen --
worse than the thing being fixed.

So: raise freely for a WRITE that must be refused, and for a read whose failure
the UI actually tells the user about. Return empty for a read the caller shrugs
off.

WHAT THIS CHECKS, behaviourally rather than by reading SQL
Every `get_*` RPC that (a) the client actually calls, (b) returns a set, and
(c) takes a single text/uuid id argument, is invoked as a real authenticated
user with an id that does not exist. A non-existent id is the cleanest possible
"no access" probe -- it needs no fixture data and no second account, and any
caller genuinely lacking access is indistinguishable from it.

An RPC that raises is then cross-checked against its CLIENT call sites, and only
reported when every one of them swallows the error into a default
(`.catch(() => ...)`). An RPC whose caller surfaces the failure is reported as a
NOTE, not a failure.

KNOWN LIMITS, stated rather than papered over:
  * Single-id-argument RPCs only. A multi-arg read is not probed, because
    synthesising the other arguments would mean inventing semantics per function.
  * "Returns a set" is read from the function's own signature (proretset), so a
    scalar getter that legitimately raises is out of scope by construction.
  * It proves the not-found path is quiet. It does not prove the found path is
    correct -- that is what the feature's own tests are for.
  * "Swallowed" is decided by looking for a `.catch(` on the call site. A caller
    that catches and then DOES surface something would read as swallowed here;
    none currently do, and the NOTE output makes the classification visible
    rather than silent.
"""
import json
import pathlib
import re
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"

# A real, ordinary user. Any authenticated account works -- the probe id is
# unreachable for everyone, which is the whole point.
PROBE_USER_SQL = """
select u.id from auth.users u
join user_entitlements ue on ue.user_id = u.id
where ue.is_premium = true limit 1
"""

CANDIDATES_SQL = """
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname like 'get\\_%'
  and p.proretset            -- returns a set, not a scalar
order by p.proname
"""

# Deliberately unreachable. A uuid that exists nowhere, and a text id no
# client-generated folder id could collide with.
PROBE_UUID = "00000000-0000-4000-8000-000000000000"
PROBE_TEXT = "__audit_probe_no_such_id__"


def mgmt(sql):
    r = subprocess.run(
        ["python3", str(BASE / "scripts" / "supabase_mgmt_api.py"), "query", sql],
        capture_output=True, text=True, cwd=str(BASE),
    )
    out = r.stdout.strip()
    if not out.startswith("["):
        raise RuntimeError(out or r.stderr)
    return json.loads(out)


def called_by_client() -> set:
    """RPC names the app actually invokes. An RPC nothing calls cannot cause a
    client-side 400, so probing it would only manufacture noise of our own."""
    names = set()
    pat = re.compile(r"""\.rpc\(\s*['"]([a-z0-9_]+)['"]""", re.I)
    for path in list(SRC.rglob("*.ts")) + list(SRC.rglob("*.tsx")):
        names.update(pat.findall(path.read_text()))
    return names


def wrapper_for(rpc: str):
    """The exported lib function that issues this RPC, if there is one."""
    pat = re.compile(r"""\.rpc\(\s*['"]%s['"]""" % re.escape(rpc))
    for path in SRC.rglob("*.ts"):
        text = path.read_text()
        m = pat.search(text)
        if not m:
            continue
        before = text[: m.start()]
        fns = re.findall(r"export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", before)
        if fns:
            return fns[-1]
    return None


def every_call_site_swallows(wrapper: str):
    """True when every call of `wrapper` outside lib/ attaches a .catch().

    That is the client stating the failure is unremarkable. A caller that awaits
    it inside a try/catch which renders an error screen does NOT match, and must
    not -- see this file's header on get_challenge_results.
    """
    sites = 0
    swallowed = 0
    pat = re.compile(r"\b%s\s*\(" % re.escape(wrapper))
    for path in list(SRC.rglob("*.tsx")) + list(SRC.rglob("*.ts")):
        if "/lib/" in str(path):
            continue
        text = path.read_text()
        for m in pat.finditer(text):
            sites += 1
            if ".catch(" in text[m.end(): m.end() + 220]:
                swallowed += 1
    return sites > 0 and sites == swallowed, sites


def main():
    users = mgmt(PROBE_USER_SQL)
    if not users:
        print("SKIP read_rpc_no_raise_audit -- no account to probe as")
        return 0
    uid = users[0]["id"]
    claims = json.dumps({"sub": uid, "role": "authenticated"}).replace("'", "''")
    prefix = ("set local role authenticated;\n"
              f"set local request.jwt.claims = '{claims}';\n")

    client_rpcs = called_by_client()
    failures, notes, checked, skipped = [], [], 0, 0

    for row in mgmt(CANDIDATES_SQL):
        name, args = row["proname"], (row["args"] or "").strip()
        if name not in client_rpcs:
            continue
        parts = [a.strip() for a in args.split(",") if a.strip()]
        if len(parts) != 1:
            skipped += 1
            continue
        argname, _, argtype = parts[0].partition(" ")
        argtype = argtype.strip().lower()
        if argtype == "uuid":
            probe = PROBE_UUID
        elif argtype in ("text", "character varying"):
            probe = PROBE_TEXT
        else:
            skipped += 1
            continue

        checked += 1
        sql = prefix + f"select count(*) as n from public.{name}('{probe}');"
        try:
            mgmt(sql)
        except RuntimeError as e:
            msg = " ".join(str(e).split())[:160]
            wrapper = wrapper_for(name)
            swallows, sites = (False, 0) if not wrapper else every_call_site_swallows(wrapper)
            if swallows:
                failures.append(
                    f"{name}({argname} {argtype}) raises for an id the caller cannot "
                    f"see, but all {sites} client call site(s) of {wrapper}() swallow it "
                    f"with .catch() -- a hard HTTP error for a state the app treats as "
                    f"normal. Return empty instead. {msg}"
                )
            else:
                notes.append(
                    f"{name} raises, and {wrapper or 'its caller'} does NOT swallow it "
                    f"({sites} call site(s)) -- the UI surfaces this, so the raise is "
                    f"doing real work. Not a defect."
                )

    for n in notes:
        print("  NOTE " + n)
    if failures:
        print("FAIL read_rpc_no_raise_audit")
        for f in failures:
            print("  - " + f)
        print("\n  A hard HTTP error for a state the app treats as normal. Not")
        print("  currently reported (Sentry captures 5xx only), but it becomes a")
        print("  reported failure the moment failedRequestStatusCodes covers 4xx.")
        return 1
    print(f"PASS read_rpc_no_raise_audit -- of {checked} client-called single-id "
          f"get_* RPC(s), none raises for an unreachable id while its caller swallows "
          f"the error ({skipped} not probed: multi-arg or non-id argument)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
