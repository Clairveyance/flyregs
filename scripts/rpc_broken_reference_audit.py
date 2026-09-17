#!/usr/bin/env python3
"""No server function may reference something that doesn't exist.

WHY THIS EXISTS
RC, 2026-09-17: "you keep telling me you've done these things, yet you always
find all kinds of new stuff... how am I supposed to take a product to market if
there are all kinds of hidden bugs that even you aren't finding?"

Fair. So this calls EVERY server function the app uses, as EVERY tier, and reads
what comes back -- rather than waiting for a user to walk down the one path that
happens to hit a broken one.

It found this on its first run:

    match_contacts_by_phone  ->  function digest(text, unknown) does not exist

Find Friends by phone number had NEVER worked, for any Pro or Premium user, since
the day it shipped. Supabase puts pgcrypto in the `extensions` schema; the
function was pinned to `search_path = public, pg_temp` and called a bare
`digest(...)`. Its sibling match_contacts_by_email calls `extensions.digest(...)`
and works fine -- same design, one of them got the schema wrong. Nobody noticed
because the client merges the email and phone results, so a thrown phone lookup
looked exactly like "none of your contacts are on FlyRegs".

HOW IT TELLS A BUG FROM A DELIBERATE REFUSAL
By SQLSTATE, not by reading the message.

  * P0001 (raise_exception) is OUR OWN `raise exception` -- "Duels requires
    Premium", "Not authorized", "Challenge not found". Intentional. Ignored here.
  * 42883 undefined_function, 42703 undefined_column, 42P01 undefined_table and
    42601 syntax_error mean the function body refers to something that is not
    there. **No input can fix that.** It is broken for every caller, every time,
    and it is always a defect.

That distinction is the whole design: a tier gate firing correctly is not a
finding, and a missing function always is.

KNOWN LIMITS, stated rather than papered over:
  * Functions are called with placeholder arguments, so a WRONG-SHAPED probe can
    produce its own error. That is exactly why only the four "doesn't exist"
    codes count -- a probe can cause 22023 or 42804, it cannot invent a missing
    function. (The first ad-hoc run of this sweep did flag
    stale_highlight_ac_ids with 22023, purely because the probe passed an object
    where the app passes a list. Not a bug, and correctly not reported now.)
  * Multi-argument functions whose types this cannot synthesise are skipped and
    counted, not silently dropped.
  * It proves the function RESOLVES. It does not prove it returns the right
    answer -- that is what the feature tests are for.
"""
import json
import pathlib
import re
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"

# SQLSTATEs that mean "this function refers to something that does not exist".
# Unreachable by any argument the caller could pass.
BROKEN_REFERENCE = {
    "42883": "function does not exist",
    "42703": "column does not exist",
    "42P01": "table does not exist",
    "42601": "syntax error",
}

PROBE = {
    "uuid": "'00000000-0000-4000-8000-000000000000'::uuid",
    "text": "'__probe__'", "character varying": "'__probe__'",
    "integer": "1", "bigint": "1", "boolean": "false", "numeric": "1",
    "jsonb": "'[]'::jsonb", "json": "'[]'::json",
    "text[]": "array['__probe__']",
    "uuid[]": "array['00000000-0000-4000-8000-000000000000'::uuid]",
    "integer[]": "array[1]",
    "date": "current_date", "timestamp with time zone": "now()",
}


def mgmt(sql):
    r = subprocess.run(
        ["python3", str(BASE / "scripts" / "supabase_mgmt_api.py"), "query", sql],
        capture_output=True, text=True, cwd=str(BASE),
    )
    out = r.stdout.strip()
    if not out.startswith("["):
        return None, (out or r.stderr)
    return json.loads(out), None


def client_rpcs() -> set:
    names = set()
    pat = re.compile(r"""\.rpc\(\s*['"]([a-z0-9_]+)['"]""", re.I)
    for p in list(SRC.rglob("*.ts")) + list(SRC.rglob("*.tsx")):
        names.update(pat.findall(p.read_text()))
    return names


def main():
    users, err = mgmt("""
      select u.id, u.email from auth.users u
      where u.email like 'tiermatrix%' order by u.email""")
    if err or not users:
        print("SKIP rpc_broken_reference_audit -- tier accounts unavailable")
        return 0

    sigs, _ = mgmt("""
      select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proretset
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public'""")
    byname = {}
    for s in sigs:
        byname.setdefault(s["proname"], []).append(s)

    wanted = client_rpcs()
    failures, checked, skipped, missing = [], 0, 0, []

    for name in sorted(wanted):
        if name not in byname:
            missing.append(name)
            continue
        sig = byname[name][0]
        args = [a.strip() for a in (sig["args"] or "").split(",") if a.strip()]
        vals, ok = [], True
        for a in args:
            atype = " ".join(a.split()[1:]).split(" DEFAULT")[0].strip().lower()
            if atype in PROBE:
                vals.append(PROBE[atype])
            else:
                ok = False
                break
        if not ok:
            skipped += 1
            continue

        call = f"public.{name}({', '.join(vals)})"
        sel = f"select count(*) from {call}" if sig["proretset"] else f"select {call}"
        checked += 1
        for u in users:
            claims = json.dumps({"sub": u["id"], "role": "authenticated"}).replace("'", "''")
            _, e = mgmt(f"set local role authenticated;\n"
                        f"set local request.jwt.claims = '{claims}';\n{sel};")
            if not e:
                continue
            m = re.search(r"ERROR:\s*([0-9A-Z]{5}):\s*(.+?)(?:\\n|\")", e)
            if not m:
                continue
            state, msg = m.group(1), " ".join(m.group(2).split())[:140]
            if state in BROKEN_REFERENCE:
                tier = u["email"].replace("tiermatrix-", "").replace("@flyregs.invalid", "")
                failures.append(f"{name}  [{tier}]  {BROKEN_REFERENCE[state]} ({state}) -- {msg}")
                break  # one report per function is enough

    if missing:
        failures.extend(f"{n} -- the app calls this RPC but it does not exist on the server"
                        for n in missing)

    if failures:
        print("FAIL rpc_broken_reference_audit")
        for f in failures:
            print("  - " + f)
        print("\n  These are broken for every caller regardless of input -- a deliberate")
        print("  tier refusal raises P0001 and is deliberately not reported here.")
        return 1
    print(f"PASS rpc_broken_reference_audit -- all {checked} client-called RPC(s) resolve "
          f"for every tier ({skipped} skipped: argument types this cannot synthesise)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
