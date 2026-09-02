"""One-time YouTube OAuth for the FlyRegs channel (support@flyregs.com).

RC runs this ONCE. It opens a browser, he picks support@flyregs.com and clicks
Allow, and the refresh token is written to .env.youtube-token.json. After that
every other script (youtube_api.py) authenticates silently and RC never touches
it again.

WHY OAUTH AND NOT A SERVICE ACCOUNT: a service account cannot own or upload to a
YouTube channel. The API requires an OAuth grant from the account that owns the
channel, so the token is tied to support@flyregs.com specifically. If RC ever
revokes app access in his Google account, re-running this restores it.

Credential files are gitignored by .gitignore's `.env.*` catch-all -- both the
client JSON and the token JSON are named .env.* deliberately for that reason.
"""
import json, os, sys, glob

CLIENT_FILE = ".env.youtube-client.json"
TOKEN_FILE = ".env.youtube-token.json"

# Scopes, narrowest set that does the job:
#   youtube.upload      -- upload video files
#   youtube             -- playlists, thumbnails, metadata edits
#   youtube.readonly    -- list/read the channel's existing videos
#   yt-analytics.readonly -- view/watch-time reporting
SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    # force-ssl is required for captions.list/download -- needed to derive REAL
    # chapter timestamps from a video's transcript. Chapters must never be
    # invented: a wrong timestamp sends the viewer to the wrong place and reads
    # as broken. Added 2026-09-02 after captions returned 403 insufficient scope.
    "https://www.googleapis.com/auth/youtube.force-ssl",
]

# NOTE: no `str | None` annotations anywhere in this file -- RC's system python3
# is 3.9, where that syntax raises TypeError at import time (it is evaluated when
# the def executes, which is why an ast.parse check does NOT catch it). Use
# Optional[...] or no annotation. Same applies to any script RC runs directly.
def find_downloaded_client():
    """Google names the download client_secret_<id>.apps.googleusercontent.com.json.
    RC should not have to rename or move anything, so look wherever he put it --
    the app folder (where every other credential lives), Downloads, or Desktop."""
    pats = []
    for d in (".", os.path.expanduser("~/Downloads"), os.path.expanduser("~/Desktop")):
        pats += [os.path.join(d, "client_secret*.json"),
                 os.path.join(d, "*googleusercontent*.json"),
                 os.path.join(d, "*oauth*client*.json")]
    hits = [f for p in pats for f in glob.glob(p)]
    return max(hits, key=os.path.getmtime) if hits else None

def main():
    if not os.path.exists(CLIENT_FILE):
        found = find_downloaded_client()
        if not found:
            print(f"No {CLIENT_FILE} here, and no client_secret*.json in ~/Downloads.")
            print("Download the OAuth client JSON from Google Cloud Console and re-run.")
            sys.exit(1)
        with open(found) as fh:
            data = json.load(fh)
        if "installed" not in data and "web" not in data:
            print(f"{found} does not look like an OAuth client file."); sys.exit(1)
        with open(CLIENT_FILE, "w") as fh:
            json.dump(data, fh)
        os.chmod(CLIENT_FILE, 0o600)
        print(f"Adopted {os.path.basename(found)} -> {CLIENT_FILE} (gitignored, chmod 600)")

    from google_auth_oauthlib.flow import InstalledAppFlow
    flow = InstalledAppFlow.from_client_secrets_file(CLIENT_FILE, SCOPES)
    print("\nA browser window will open.")
    print("  1. Choose support@flyregs.com  (NOT a personal account)")
    print("  2. 'Google hasn't verified this app' is expected in Testing mode:")
    print("     click Advanced -> Go to FlyRegs (unsafe). It is your own app.")
    print("  3. Leave every checkbox ticked and click Continue.\n")
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
    if not creds.refresh_token:
        print("No refresh token returned. Re-run; the consent screen must be shown at least once.")
        sys.exit(1)
    with open(TOKEN_FILE, "w") as fh:
        fh.write(creds.to_json())
    os.chmod(TOKEN_FILE, 0o600)
    print(f"\nAuthorised. Token saved to {TOKEN_FILE} (gitignored, chmod 600).")
    print("You are done -- I can take it from here.")

if __name__ == "__main__":
    main()
