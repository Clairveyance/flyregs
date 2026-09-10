#!/bin/bash
# Local iOS build with Xcode 26.3 (Swift 6.2.4) -- the toolchain Expo SDK 56 / RN 0.85 requires.
#
# PREREQUISITE, ONE TIME, NEEDS RC'S PASSWORD (Claude cannot run sudo):
#   sudo env DEVELOPER_DIR=/Applications/Xcode-26.3.app/Contents/Developer xcodebuild -license accept
#
# Deliberately uses DEVELOPER_DIR instead of `xcode-select -s` so the global
# toolchain stays on Xcode 16.4 -- switching it system-wide has broken python3 here before.
set -euo pipefail

export DEVELOPER_DIR=/Applications/Xcode-26.3.app/Contents/Developer
PROJ_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SIM_UDID="${SIM_UDID:-DBE4D72A-390A-472E-AD4C-FCAEA0B8C84E}"   # iPhone 13 mini, RC's device class
DERIVED="$PROJ_DIR/build/DerivedData"

echo "==> Xcode: $(xcodebuild -version | head -1)"
echo "==> Swift: $("$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift" --version | head -1)"

cd "$PROJ_DIR/ios"
# Ask the WORKSPACE explicitly. With both a .xcodeproj and a .xcworkspace in
# this directory, a bare `xcodebuild -list` describes the PROJECT, so the JSON
# has a "project" key and not "workspace" -- the first version indexed
# ["workspace"] and died on a KeyError before building anything.
WS="$(ls -d *.xcworkspace | head -1)"
# Pick the APP scheme by name, never schemes[0]. CocoaPods puts ~150 schemes in
# this workspace and the first alphabetically is "EXApplication", an Expo pod --
# building that got as far as "Available destinations: macOS Catalyst only"
# before failing, which reads like a simulator problem and is not one.
APP_SCHEME="${APP_SCHEME:-${WS%.xcworkspace}}"
SCHEME="$(xcodebuild -list -json -workspace "$WS" 2>/dev/null \
  | APP_SCHEME="$APP_SCHEME" python3 -c 'import json, os, sys
d = json.load(sys.stdin)
schemes = (d.get("workspace") or d["project"])["schemes"]
want = os.environ["APP_SCHEME"]
if want not in schemes:
    sys.exit(f"scheme {want!r} not in the workspace; have {schemes[:5]}...")
print(want)')"
echo "==> Scheme: $SCHEME"

xcodebuild \
  -workspace "$WS" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "id=$SIM_UDID" \
  -derivedDataPath "$DERIVED" \
  build | tee "$PROJ_DIR/build/xcodebuild.log" | tail -40

APP="$(find "$DERIVED/Build/Products" -name '*.app' -maxdepth 3 | head -1)"
echo "==> Built: $APP"

xcrun simctl boot "$SIM_UDID" 2>/dev/null || true
xcrun simctl install "$SIM_UDID" "$APP"
echo "==> Installed to simulator $SIM_UDID"
echo "==> Now test the AD compliance keyboard at BOTH entry points:"
echo "      src/app/my-aircraft/index.tsx:2439   and   src/app/my-aircraft/[id].tsx:1615"
echo "==> REMINDER: turn OFF Simulator > I/O > Keyboard > Connect Hardware Keyboard,"
echo "    or the software keyboard never appears and the test proves nothing."
