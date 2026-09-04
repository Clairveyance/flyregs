#!/usr/bin/env python3
"""Can a stranger with only the anon key enumerate everyone's photos?

The anon key ships inside every copy of the app, so "you need the anon key"
is not a barrier -- it is public. This walks the two PUBLIC storage buckets
(avatars, aircraft-images) as an anonymous caller and as a real signed-in
user, and checks four things at once:

  1. an anonymous caller cannot LIST either bucket (the leak: folder names
     are user ids and aircraft ids, and the objects behind them are photos);
  2. a signed-in user cannot list OTHER people's folders either;
  3. a signed-in user CAN still see their own row -- storage delete and
     replace depend on that visibility (see the RLS update/delete gotcha),
     so tightening this too far silently breaks changing your photo;
  4. every photo still renders for everyone through the public URL with no
     auth at all, which is the whole reason these buckets are public.

Run it before and after any storage-policy change. Exit 1 on any failure.
"""
import json
import os
import re
import secrets
import sys
import time
import uuid
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILURES = []

env = open(os.path.join(BASE, ".env")).read()
g = lambda k: re.search(rf"^{k}=(.*)$", env, re.M).group(1).strip()
URL, ANON = g("EXPO_PUBLIC_SUPABASE_URL"), g("EXPO_PUBLIC_SUPABASE_ANON_KEY")
SERVICE = re.search(r"^\s*(?:export\s+)?SUPABASE_SERVICE_KEY=(.+)$",
                    open(os.path.join(BASE, ".env.scraper")).read(), re.M).group(1).strip()


def req(method, path, *, key=None, jwt=None, body=None, raw=None, ctype=None, headers=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(URL + path, data=data, method=method)
    if key:
        r.add_header("apikey", key)
        r.add_header("Authorization", f"Bearer {jwt or key}")
    if data is not None:
        r.add_header("Content-Type", ctype or "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=30) as x:
            txt = x.read()
            try:
                return x.status, json.loads(txt.decode() or "null")
            except Exception:
                return x.status, txt
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def listing(bucket, *, key, jwt=None, prefix=""):
    st, body = req("POST", f"/storage/v1/object/list/{bucket}",
                   key=key, jwt=jwt, body={"prefix": prefix, "limit": 100})
    return st, (body if isinstance(body, list) else [])


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if not cond else ""))
    if not cond:
        FAILURES.append(label)


def main():
    uid = jwt = None
    try:
        # A real signed-in user, so "can a legitimate user still manage their
        # own photo" is answered by the actual RLS path and not assumed.
        email = f"storagetest-{int(time.time())}@flyregs.invalid"
        pw = f"Tmp{secrets.token_urlsafe(12)}!"
        st, u = req("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": pw, "email_confirm": True})
        if st != 200:
            raise SystemExit(f"could not create test user: {st} {u}")
        uid = u["id"]
        st, tok = req("POST", "/auth/v1/token?grant_type=password", key=ANON,
                      body={"email": email, "password": pw})
        jwt = tok["access_token"]
        # Premium, so fleet_visible_cap does not reject the fixture's aircraft
        # for a reason that has nothing to do with storage.
        st, body = req("POST", "/rest/v1/user_entitlements", key=SERVICE,
                       body={"user_id": uid, "is_pro": True, "is_premium": True},
                       headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
        if st >= 300:
            raise SystemExit(f"could not grant Premium to the fixture: {st} {body}")

        # A 1x1 JPEG, uploaded through the same path avatar.ts uses.
        jpeg = bytes.fromhex(
            "ffd8ffe000104a46494600010100000100010000ffdb004300ffffffffffffff"
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc200"
            "0b080001000101011100ffc40014000100000000000000000000000000000009"
            "ffda0008010100013f10")
        path = f"{uid}/avatar.jpg"
        st, body = req("POST", f"/storage/v1/object/avatars/{path}", key=ANON, jwt=jwt,
                       raw=jpeg, ctype="image/jpeg")
        check("a signed-in user can upload their own avatar", st < 300, f"HTTP {st} {body}")

        print("\n=== 1. Can a stranger enumerate the buckets? ===")
        for bucket in ("avatars", "aircraft-images"):
            st, rows = listing(bucket, key=ANON)
            check(f"anon cannot list {bucket}", not rows,
                  f"HTTP {st}, {len(rows)} folders visible: {[r.get('name') for r in rows[:5]]}")

        print("\n=== 2. Can a signed-in user enumerate other people's? ===")
        for bucket in ("avatars", "aircraft-images"):
            st, rows = listing(bucket, key=ANON, jwt=jwt)
            others = [r.get("name") for r in rows if r.get("name") != uid]
            check(f"a signed-in user sees no one else's folders in {bucket}",
                  not others, f"saw {others[:5]}")

        print("\n=== 3. Can they still manage their OWN photo? ===")
        st, rows = listing("avatars", key=ANON, jwt=jwt, prefix=uid)
        check("their own avatar row is visible to them (storage delete/replace "
              "needs this -- see the RLS update/delete gotcha)",
              any(r.get("name") == "avatar.jpg" for r in rows), f"HTTP {st} {rows}")
        st, body = req("DELETE", f"/storage/v1/object/avatars/{path}", key=ANON, jwt=jwt)
        check("they can delete their own avatar (this is what 'change photo' does)",
              st < 300, f"HTTP {st} {body}")

        print("\n=== 4. The aircraft-photo replace path, end to end ===")
        # aircraftImage.ts uploads to <aircraftId>/photo-<hash>.jpg, points
        # user_aircraft.image_path at it, THEN removes the previous object.
        # That last step is a storage DELETE, which needs the old row to be
        # visible under the narrowed SELECT policy -- run the whole sequence
        # rather than trusting that the policies match.
        acid = str(uuid.uuid4())
        st, body = req("POST", "/rest/v1/user_aircraft", key=ANON, jwt=jwt,
                       body={"id": acid, "user_id": uid, "nickname": "STORTEST",
                             "type_designator": "C172", "make": "Cessna",
                             "model": "172S"})
        check("the test user has an aircraft to attach a photo to",
              st < 300, f"HTTP {st} {body}")
        old_path, new_path = f"{acid}/photo-old.jpg", f"{acid}/photo-new.jpg"
        st, _ = req("POST", f"/storage/v1/object/aircraft-images/{old_path}",
                    key=ANON, jwt=jwt, raw=jpeg, ctype="image/jpeg")
        check("owner can upload an aircraft photo", st < 300, f"HTTP {st}")
        st, _ = req("POST", f"/storage/v1/object/aircraft-images/{new_path}",
                    key=ANON, jwt=jwt, raw=jpeg, ctype="image/jpeg")
        st, _ = req("PATCH", f"/rest/v1/user_aircraft?id=eq.{acid}", key=ANON, jwt=jwt,
                    body={"image_path": new_path})
        st, body = req("DELETE", f"/storage/v1/object/aircraft-images/{old_path}",
                       key=ANON, jwt=jwt)
        check("owner can remove the PREVIOUS photo (the replace path's last step)",
              st < 300, f"HTTP {st} {body}")
        req("DELETE", f"/storage/v1/object/aircraft-images/{new_path}", key=SERVICE)
        req("DELETE", f"/rest/v1/user_aircraft?id=eq.{acid}", key=SERVICE)

        print("\n=== 5. Are the photo buckets bounded? ===")
        # Both buckets are public and both accepted any size and any type
        # until 2026-09-04 -- free unauthenticated file hosting on RC's
        # storage bill for anyone who signs up. Real photos top out around
        # 400 KB, so a legitimate upload cannot reach these limits.
        st, body = req("POST", f"/storage/v1/object/avatars/{uid}/big.jpg",
                       key=ANON, jwt=jwt, raw=b"\0" * (11 * 1024 * 1024),
                       ctype="image/jpeg")
        check("an oversized upload is rejected", st >= 400, f"HTTP {st}")
        st, body = req("POST", f"/storage/v1/object/avatars/{uid}/payload.bin",
                       key=ANON, jwt=jwt, raw=b"MZ\x90\x00" * 100,
                       ctype="application/octet-stream")
        check("a non-image upload is rejected", st >= 400, f"HTTP {st}")

        print("\n=== 6. Do photos still render for everyone? ===")
        # Re-upload, then fetch the public URL with NO credentials at all --
        # the path every avatar and aircraft photo in the app actually uses.
        req("POST", f"/storage/v1/object/avatars/{path}", key=ANON, jwt=jwt,
            raw=jpeg, ctype="image/jpeg")
        r = urllib.request.Request(f"{URL}/storage/v1/object/public/avatars/{path}")
        try:
            with urllib.request.urlopen(r, timeout=20) as x:
                ok, detail = x.status == 200 and len(x.read()) > 0, f"HTTP {x.status}"
        except urllib.error.HTTPError as e:
            ok, detail = False, f"HTTP {e.code}"
        check("an unauthenticated public URL still serves the image "
              "(getPublicUrl -- avatar.ts:77, aircraftImage.ts:45)", ok, detail)

    finally:
        if uid:
            req("DELETE", f"/storage/v1/object/avatars/{uid}/avatar.jpg", key=SERVICE)
            req("DELETE", f"/auth/v1/admin/users/{uid}", key=SERVICE)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("Photos render for everyone; nobody can enumerate either bucket.")


if __name__ == "__main__":
    main()
