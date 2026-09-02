"""YouTube helper for the FlyRegs tutorial channel (support@flyregs.com).

Authenticates from .env.youtube-token.json, written once by youtube_auth.py.
Refreshes itself silently, so this never prompts RC again.

    python3 scripts/youtube_api.py channel
    python3 scripts/youtube_api.py list [--max N]        # includes PRIVATE videos
    python3 scripts/youtube_api.py get <videoId>
    python3 scripts/youtube_api.py quota                 # what today's calls cost

QUOTA, because it is the real constraint and it is easy to burn silently:
default is 10,000 units/day. An upload is 1,600 (about 6/day), a thumbnail set
is 50, a metadata update is 50, and a list/read is 1. Every write path here
prints what it spent.

Deliberately NOT implemented as a one-shot: uploading and publishing are
outward-facing and effectively irreversible once public, so upload defaults to
privacyStatus='private' and there is no --public flag. RC flips a video public
in YouTube Studio when he has watched it. See feedback_no_spending_without_approval
and the standing rule on publishing.
"""
import sys, os, json, argparse

TOKEN_FILE = ".env.youtube-token.json"
CLIENT_FILE = ".env.youtube-client.json"
SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]

def service():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    if not os.path.exists(TOKEN_FILE):
        sys.exit(f"{TOKEN_FILE} not found -- run: python3 scripts/youtube_auth.py")
    creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            with open(TOKEN_FILE, "w") as fh:
                fh.write(creds.to_json())
        else:
            sys.exit("Token invalid and not refreshable -- re-run youtube_auth.py")
    return build("youtube", "v3", credentials=creds, cache_discovery=False)

def cmd_channel(yt, _):
    r = yt.channels().list(part="snippet,contentDetails,statistics,status", mine=True).execute()
    for c in r.get("items", []):
        s, st = c["snippet"], c.get("statistics", {})
        print(f"  channel   : {s['title']}  ({c['id']})")
        print(f"  handle    : {s.get('customUrl','(none set)')}")
        print(f"  videos    : {st.get('videoCount','?')}   views: {st.get('viewCount','?')}   subs: {st.get('subscriberCount','?')}")
        print(f"  uploads pl: {c['contentDetails']['relatedPlaylists']['uploads']}")
        # A channel that is not phone-verified silently fails thumbnail uploads,
        # so surface it here rather than after a confusing 403 mid-batch.
        print(f"  can upload custom thumbnails: {c.get('status',{}).get('longUploadsStatus','unknown')}")
    print("\n  cost: 1 unit")

def cmd_list(yt, args):
    ch = yt.channels().list(part="contentDetails", mine=True).execute()
    uploads = ch["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]
    items, token, cost = [], None, 1
    while len(items) < args.max:
        r = yt.playlistItems().list(part="snippet,status", playlistId=uploads,
                                    maxResults=min(50, args.max - len(items)),
                                    pageToken=token).execute()
        cost += 1
        items += r.get("items", [])
        token = r.get("nextPageToken")
        if not token: break
    ids = [i["snippet"]["resourceId"]["videoId"] for i in items]
    if ids:
        det = yt.videos().list(part="snippet,status,statistics,contentDetails",
                               id=",".join(ids)).execute()
        cost += 1
        for v in det.get("items", []):
            s, st = v["snippet"], v["status"]
            print(f"\n  [{st['privacyStatus'].upper()}] {s['title']}")
            print(f"     id       : {v['id']}")
            print(f"     published: {s['publishedAt'][:10]}   duration: {v['contentDetails']['duration']}")
            print(f"     tags     : {', '.join(s.get('tags', [])) or '(none)'}")
            print(f"     desc     : {(s.get('description','') or '(empty)')[:160].replace(chr(10),' ')}")
    else:
        print("  no videos on this channel yet")
    print(f"\n  {len(ids)} video(s)   cost: {cost} units")

def cmd_get(yt, args):
    r = yt.videos().list(part="snippet,status,statistics,contentDetails,localizations",
                         id=args.video_id).execute()
    if not r.get("items"): sys.exit("no such video (or not owned by this channel)")
    print(json.dumps(r["items"][0], indent=2)[:4000])
    print("\n  cost: 1 unit")

def cmd_quota(yt, _):
    print("  YouTube Data API v3 default: 10,000 units/day, resets midnight Pacific")
    print("    videos.insert (upload)   1,600   -> ~6 uploads/day")
    print("    thumbnails.set              50")
    print("    videos.update               50")
    print("    playlists.insert            50")
    print("    *.list (reads)               1")
    print("  Raise it via the Quotas page -> YouTube Data API v3 -> request increase (free).")

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("channel")
    p = sub.add_parser("list"); p.add_argument("--max", type=int, default=50)
    p = sub.add_parser("get"); p.add_argument("video_id")
    sub.add_parser("quota")
    args = ap.parse_args()
    if args.cmd == "quota":
        return cmd_quota(None, args)
    yt = service()
    {"channel": cmd_channel, "list": cmd_list, "get": cmd_get}[args.cmd](yt, args)

if __name__ == "__main__":
    main()
