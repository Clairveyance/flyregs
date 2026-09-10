"""Audit: ACS task -> regulation links are relevant, resolvable, and honest.

RC, 2026-09-09: CFI Task I.A "Effects of Human Behavior and Communication on
the Learning Process" showed AC 90-117 "Data Link Communications" as a related
reg, matched on the single word "communication". This is the executable guard
against that whole class of defect coming back -- a markdown note would only
have protected the corpus as it stood the day it was written.

Fails on:
  1. a link on a task whose References field cites NO regulatory source
     (handbook-only) -- the exact shape of RC's bug
  2. a link pointing at a section/AC/paragraph that does not exist
  3. a FAR link outside the parts the ACS itself cites
  4. a FAR link for a certificate level the ACS document is not for
  5. the specific AC 90-117 regression, by name
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from access_matrix_sweep import mgmt  # noqa: E402
from build_acs_reg_links import cited_far_parts, cited_acs, cites_aim, doc_level  # noqa: E402

fails = []


def resolve_ac_in(doc_id, named):
    """Return the ACS citation that `doc_id` satisfies, or None.

    The ACS cites base numbers ("AC 61-65"); the corpus stores revisions
    ("61-65K"). Compare on the base so a revision still counts as cited.
    """
    u = (doc_id or "").upper()
    base = re.sub(r"[A-Z]$", "", u)
    for n in named:
        if base == re.sub(r"[A-Z]$", "", n.upper()):
            return n
    return None


def real_user_can_read():
    """Read the table the way the APP does -- anon key + a real user JWT.

    2026-09-10, and this is the check that mattered most. Every other check in
    this file queries through the Management API as `service_role`, which
    bypasses both RLS and table grants. They all passed while the feature was
    completely dead for real users: `acs_task_reg_links` had its RLS policy
    (`acs_task_reg_links_public_read`, SELECT to `public`) but NO
    `GRANT SELECT ... TO anon, authenticated`, so PostgREST returned

        403 42501 permission denied for table acs_task_reg_links

    to every request the app made. `getCuratedTaskLinks` maps any error to
    `null`, and the screen treats `null` as "lookup failed, fall back to the old
    keyword search" -- so the app silently kept showing exactly the results RC
    reported (AC 90-117 on CFI Task I.A) while this audit reported PASS.

    An RLS policy is not a grant. Test the path the user takes.
    """
    def load(fn):
        d = {}
        for line in open(os.path.join(BASE, fn)):
            line = line.strip().removeprefix("export ")
            if line and not line.startswith("#"):
                k, _, v = line.partition("=")
                d[k] = v.strip().strip('"').strip("'")
        return d

    def call(u, b=None, h=None):
        r = urllib.request.Request(
            u, data=json.dumps(b).encode() if b is not None else None,
            headers=h or {}, method="POST" if b is not None else "GET")
        try:
            with urllib.request.urlopen(r, timeout=30) as x:
                return x.status, x.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    env = load(".env.scraper")
    url, svc = env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"]
    anon = load(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
    h = {"apikey": svc, "Authorization": "Bearer " + svc, "Content-Type": "application/json"}
    _, b = call(f"{url}/auth/v1/admin/generate_link",
                {"type": "magiclink", "email": "tiermatrix-pro@flyregs.invalid"}, h)
    lk = json.loads(b)
    th = lk.get("hashed_token") or lk.get("properties", {}).get("hashed_token")
    _, b = call(f"{url}/auth/v1/verify", {"type": "magiclink", "token_hash": th},
                {"apikey": anon, "Content-Type": "application/json"})
    tok = json.loads(b)["access_token"]
    st, body = call(f"{url}/rest/v1/acs_task_reg_links?select=cited_id&limit=1", None,
                    {"apikey": anon, "Authorization": "Bearer " + tok})
    return st, body


def main():
    st, body = real_user_can_read()
    if st != 200:
        print(f"FAIL  a real signed-in user cannot read acs_task_reg_links -- HTTP {st}")
        print("      " + body[:200])
        print("      The app maps this to a failed lookup and falls back to keyword search,")
        print("      so the curated links are invisible. Fix:")
        print("      GRANT SELECT ON public.acs_task_reg_links TO anon, authenticated;")
        return 1
    print("  a real signed-in user CAN read acs_task_reg_links (HTTP 200)")

    links = mgmt("""select doc_code,area_number,task_letter,cited_type,cited_id,source
                    from acs_task_reg_links""")
    tasks = {(t["doc_code"], t["area_number"], t["task_letter"]): t
             for t in mgmt("select doc_code,area_number,task_letter,title,references_text from acs_tasks")}
    doc_titles = {d["code"]: d["title"] for d in mgmt("select code,title from acs_documents")}
    far_ids = {r["section_number"] for r in mgmt("select section_number from far_sections")}
    far_lvl = {r["section_number"]: set(r["levels"] or []) for r in mgmt(
        "select section_number, far_all_levels(part,subpart_letter,section_number) levels from far_sections")}
    ac_ids = {r["document_number"] for r in mgmt("select document_number from advisory_circulars")}
    aim_ids = {r["paragraph_number"] for r in mgmt("select paragraph_number from aim_paragraphs")}

    print(f"checking {len(links)} links across {len({(l['doc_code'],l['area_number'],l['task_letter']) for l in links})} tasks")

    for l in links:
        key = (l["doc_code"], l["area_number"], l["task_letter"])
        t = tasks.get(key)
        if not t:
            fails.append(f"{key} {l['cited_type']} {l['cited_id']}: link on a task that does not exist")
            continue
        rt = t["references_text"] or ""
        parts, named, aim = cited_far_parts(rt), cited_acs(rt), cites_aim(rt)
        curated = l.get("source") == "curated"

        # A CURATED link is hand-verified against the regulation's own text, so
        # it is exempt from the PROVENANCE checks below -- those all ask "did
        # the ACS cite this?", and the whole point of a curated link is that the
        # ACS did not, wrongly. § 61.185(a)(1) enumerates the six
        # fundamentals-of-instructing subjects by name while the FOI tasks'
        # References list only handbooks.
        #
        # It is NOT exempt from resolvability or certificate level: a curated
        # link that points at a section which does not exist, or at the wrong
        # certificate, is a defect no matter who wrote it.
        if curated:
            pool = {"far": far_ids, "ac": ac_ids, "aim": aim_ids}.get(l["cited_type"])
            if pool is not None and l["cited_id"] not in pool:
                fails.append(f"{key} CURATED {l['cited_type']} {l['cited_id']}: does not exist in the corpus")
                continue
            if l["cited_type"] == "far":
                want = doc_level(doc_titles.get(l["doc_code"]))
                sl = far_lvl.get(l["cited_id"]) or set()
                if want and sl and sl != {"not_applicable"} and want not in sl:
                    fails.append(f"{key} CURATED far {l['cited_id']}: level {sorted(sl)} "
                                 f"excludes doc level '{want}'")
            continue

        # (1) handbook-only task must carry no links at all
        if not parts and not named and not aim:
            fails.append(f"{key} '{t['title'][:40]}': has a {l['cited_type']} link "
                         f"({l['cited_id']}) but its References cite no regulatory source -- {rt[:60]}")
            continue

        # (2) resolvable
        pool = {"far": far_ids, "ac": ac_ids, "aim": aim_ids}.get(l["cited_type"])
        if pool is not None and l["cited_id"] not in pool:
            fails.append(f"{key} {l['cited_type']} {l['cited_id']}: does not exist in the corpus")
            continue

        # (2b) an AC link must be one the ACS ITSELF cited.
        #
        # 2026-09-10. The builder used to append the top 4 TF-IDF AC matches to
        # any task that cited a part, which put "AC 93-3 Lengthy Tarmac Delays"
        # on 79 tasks including "Normal Approach and Landing" and
        # "Communications, Light Signals, and Runway Lighting Systems" -- RC's
        # AC 90-117 bug with different documents. Check (5) below only guards
        # that ONE pair by name, which is why it never fired. This is the
        # general form, and it is the check that would have caught it.
        if l["cited_type"] == "ac":
            if not named:
                fails.append(f"{key} '{t['title'][:40]}': AC {l['cited_id']} but the "
                             f"References name no AC at all -- {rt[:60]}")
                continue
            if resolve_ac_in(l["cited_id"], named) is None:
                fails.append(f"{key} ac {l['cited_id']}: not among the ACs the ACS cites {named} "
                             f"-- keyword-guessed AC links are not allowed")
                continue

        if l["cited_type"] == "far":
            # (3) inside a cited part
            if l["cited_id"].split(".")[0] not in parts:
                fails.append(f"{key} far {l['cited_id']}: outside the cited parts {parts}")
            # (4) right certificate level
            want = doc_level(doc_titles.get(l["doc_code"]))
            sl = far_lvl.get(l["cited_id"]) or set()
            if want and sl and sl != {"not_applicable"} and want not in sl:
                fails.append(f"{key} far {l['cited_id']}: level {sorted(sl)} excludes doc level '{want}'")

    # (5) the named regression
    for l in links:
        if l["cited_id"] == "90-117" and l["doc_code"] == "FAA-S-ACS-25" and l["area_number"] == "I":
            fails.append("REGRESSION: AC 90-117 is back on CFI Area I -- the original reported bug")

    handbook_only = sum(1 for t in tasks.values()
                        if not cited_far_parts(t["references_text"] or "")
                        and not cited_acs(t["references_text"] or "")
                        and not cites_aim(t["references_text"] or ""))
    print(f"  {handbook_only} handbook-only tasks correctly carry no links")

    if fails:
        print(f"\nFAIL  {len(fails)} problem(s):")
        for f in fails[:40]:
            print("   -", f)
        if len(fails) > 40:
            print(f"   ... and {len(fails)-40} more")
        return 1
    print("\nPASS  every ACS reg link is inside its task's cited parts, at the right "
          "certificate level, resolvable, and absent from handbook-only tasks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
