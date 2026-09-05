#!/usr/bin/env python3
"""End-to-end aircraft photo test: upload, public render, replace, orphan
cleanup, cross-user isolation, and the bucket's own size/mime caps.

WHY THIS EXISTS
RC, 2026-09-05: "error, could not update the a/c photo" on B40, and then
"just make sure it's all fixed." The reported failure was expo-crypto's
digest() rejecting a raw ArrayBuffer at the iOS native boundary -- which
cannot be reproduced off-device, and is now both fixed AND wrapped so that a
failure in the cache-busting hash can no longer take the whole upload down
(see contentVersion in src/lib/aircraftImage.ts).

Everything AROUND that native call is testable, and none of it was: the
storage policies, the public-URL render path, the replace-then-delete
sequence that content-addressed paths made necessary, and the bucket caps
added on 2026-09-04. This covers that half, honestly labelled -- it does not
and cannot prove the native digest call itself.

Real user JWTs against the real project, same pattern as
aircraft_e2e_test.py / aircraft_sharing_e2e_test.py.

Usage:  python3 scripts/aircraft_photo_e2e_test.py
"""
import json
import os
import secrets
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
URL = SCRAPER["SUPABASE_URL"]
SERVICE = SCRAPER["SUPABASE_SERVICE_KEY"]
ANON = load_env(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]

FAILURES = []


def http(method, path, *, key=None, jwt=None, body=None, headers=None, raw=None, absolute=False):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request((path if absolute else URL + path), data=data, method=method)
    if key:
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {jwt or key}")
    if body is not None and raw is None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            payload = r.read()
            try:
                return r.status, json.loads(payload.decode())
            except Exception:
                return r.status, payload
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload.decode())
        except Exception:
            return e.code, payload


def check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}   {detail}")
        FAILURES.append(f"{label} :: {detail}")
    return cond


def make_user(prefix):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = http("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": password, "email_confirm": True,
                          "user_metadata": {"display_name": prefix.upper()}})
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    return {"id": body["id"], "jwt": tok["access_token"]}


def delete_user(uid):
    http("DELETE", f"/auth/v1/admin/users/{uid}", key=SERVICE)


def grant_premium(uid):
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_premium": True},
         headers={"Prefer": "resolution=merge-duplicates"})


def png_bytes(r, g, b, pad=0):
    """A real, valid 1x1 PNG. `pad` appends bytes after IEND so two images can
    differ in content (and therefore in hash) while both staying decodable --
    the exact condition the content-addressed path depends on."""
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    raw = b"\x00" + bytes([r, g, b])
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b"") + (b"\x00" * pad))


def upload(jwt, path, data, content_type="image/png", upsert=True):
    return http("POST", f"/storage/v1/object/aircraft-images/{path}", key=ANON, jwt=jwt,
                raw=data, headers={"Content-Type": content_type, "x-upsert": "true" if upsert else "false"})


def public_url(path):
    return f"{URL}/storage/v1/object/public/aircraft-images/{path}"


def main():
    owner = make_user("acphotoA")
    stranger = make_user("acphotoB")
    grant_premium(owner["id"])
    grant_premium(stranger["id"])
    aircraft_id = None
    try:
        st, body = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=owner["jwt"],
                        headers={"Prefer": "return=representation"},
                        body={"user_id": owner["id"], "make": "Cessna", "model": "172S",
                              "nickname": "PhotoTest"})
        aircraft_id = body[0]["id"] if isinstance(body, list) and body else None
        if not check("aircraft created", bool(aircraft_id), f"{st} {body}"):
            return

        print("\n=== UPLOAD (the path uploadAircraftImageAsset builds) ===")
        img1 = png_bytes(255, 0, 0)
        p1 = f"{aircraft_id}/photo-aaaaaaaaaaaa.jpg"
        st, body = upload(owner["jwt"], p1, img1)
        check("owner can upload into their own aircraft folder", st in (200, 201), f"{st} {body}")

        st, body = http("PATCH", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=ANON, jwt=owner["jwt"],
                        headers={"Prefer": "return=representation"}, body={"image_path": p1})
        check("image_path saved on the row", st in (200, 204), f"{st} {body}")

        print("\n=== RENDER (getAircraftImageUrl -> a bare <Image> with no auth) ===")
        st, payload = http("GET", public_url(p1), absolute=True)
        check("public URL returns 200 with NO auth header", st == 200, str(st))
        check("public URL returns the exact bytes uploaded", payload == img1,
              f"{len(payload) if isinstance(payload, bytes) else payload} vs {len(img1)}")

        print("\n=== REPLACE (new content hash -> new object, old one removed) ===")
        img2 = png_bytes(0, 0, 255, pad=32)
        p2 = f"{aircraft_id}/photo-bbbbbbbbbbbb.jpg"
        st, body = upload(owner["jwt"], p2, img2)
        check("replacement uploads to its own path", st in (200, 201), f"{st} {body}")
        http("PATCH", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=ANON, jwt=owner["jwt"],
             body={"image_path": p2})
        st, _ = http("GET", public_url(p2), absolute=True)
        check("new photo renders", st == 200, str(st))
        st, body = http("DELETE", "/storage/v1/object/aircraft-images", key=ANON, jwt=owner["jwt"],
                        body={"prefixes": [p1]})
        check("owner can delete the superseded object", st in (200, 204), f"{st} {body}")
        # Checked through the STORAGE API, not the public URL. Supabase serves
        # public objects with `cache-control: public, max-age=3600` behind a
        # CDN, so the old URL keeps answering 200 from cache for up to an hour
        # after the object is genuinely deleted -- verified directly against
        # storage.objects, which had no row for it. That stale copy is
        # harmless here precisely because paths are content-addressed: a
        # replacement lands on a NEW path, so nothing ever asks for the old
        # URL again. Asserting on the CDN would be asserting on a cache.
        st, body = http("POST", "/storage/v1/object/list/aircraft-images", key=SERVICE,
                        body={"prefix": str(aircraft_id), "limit": 100})
        names = [o.get("name") for o in (body if isinstance(body, list) else [])]
        check("superseded object is really deleted from storage",
              "photo-aaaaaaaaaaaa.jpg" not in names, f"{st} {names}")
        check("the replacement object is still there", "photo-bbbbbbbbbbbb.jpg" in names, f"{st} {names}")

        print("\n=== ISOLATION ===")
        st, body = upload(stranger["jwt"], f"{aircraft_id}/photo-cccccccccccc.jpg", png_bytes(0, 255, 0))
        check("a stranger CANNOT upload into someone else's aircraft folder", st >= 400, f"{st} {body}")
        st, body = http("DELETE", "/storage/v1/object/aircraft-images", key=ANON, jwt=stranger["jwt"],
                        body={"prefixes": [p2]})
        gone = http("GET", public_url(p2), absolute=True)[0]
        check("a stranger CANNOT delete someone else's photo", gone == 200, f"delete={st} then GET={gone}")
        st, body = http("GET", "/storage/v1/object/list/aircraft-images", key=ANON, jwt=stranger["jwt"],
                        body={"prefix": "", "limit": 100})
        leaked = [o for o in (body if isinstance(body, list) else []) if o.get("name") == str(aircraft_id)]
        check("a stranger CANNOT enumerate the bucket", not leaked, f"{st} {str(body)[:200]}")

        print("\n=== BUCKET CAPS (added 2026-09-04) ===")
        st, body = upload(owner["jwt"], f"{aircraft_id}/photo-dddddddddddd.jpg", b"not an image at all",
                          content_type="application/pdf")
        check("a non-image mime type is rejected", st >= 400, f"{st} {body}")
        st, body = upload(owner["jwt"], f"{aircraft_id}/photo-eeeeeeeeeeee.jpg", b"\x00" * (11 * 1024 * 1024))
        check("an over-10MB upload is rejected", st >= 400, f"{st} {str(body)[:120]}")

        print("\n=== REMOVE PHOTO (removeAircraftImage) ===")
        http("DELETE", "/storage/v1/object/aircraft-images", key=ANON, jwt=owner["jwt"], body={"prefixes": [p2]})
        st, body = http("PATCH", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=ANON, jwt=owner["jwt"],
                        headers={"Prefer": "return=representation"}, body={"image_path": None})
        cleared = isinstance(body, list) and body and body[0].get("image_path") is None
        check("image_path cleared back to null", cleared, f"{st} {body}")
    finally:
        if aircraft_id:
            http("DELETE", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=SERVICE)
            http("DELETE", "/storage/v1/object/aircraft-images", key=SERVICE,
                 body={"prefixes": [f"{aircraft_id}/photo-aaaaaaaaaaaa.jpg",
                                    f"{aircraft_id}/photo-bbbbbbbbbbbb.jpg",
                                    f"{aircraft_id}/photo-cccccccccccc.jpg"]})
        delete_user(owner["id"])
        delete_user(stranger["id"])

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)
    print("aircraft photo e2e: all checks passed")
    print("NOT covered here: expo-crypto's native digest() call, which only")
    print("exists on a device. That is the piece RC actually hit.")


if __name__ == "__main__":
    main()
