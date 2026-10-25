#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Build this package on an Apple silicon Mac.' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
electron_version='44.9.0'
electron_archive="electron-v${electron_version}-darwin-arm64.zip"
electron_sha='12d873a5ae98a6598e730402e9278c5d132e97ea1a4405a7713bec2a3e83921f'
download_dir="$repo_root/.downloads"
output_dir="$repo_root/dist"
work_dir="$output_dir/Theater Simple macOS Apple silicon 1.2.0-macos.1"
app="$work_dir/Theater Simple.app"
package="$output_dir/Theater Simple macOS Apple silicon 1.2.0-macos.1.zip"

mkdir -p "$download_dir" "$output_dir"
if [[ -e "$work_dir" || -e "$package" ]]; then
  echo 'A Mac build already exists. Preserve it and use a clean checkout for another build.' >&2
  exit 1
fi

archive="$download_dir/$electron_archive"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 --output "$archive" "https://github.com/electron/electron/releases/download/v${electron_version}/${electron_archive}"
fi
actual_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$actual_sha" != "$electron_sha" ]]; then
  echo 'Electron archive checksum mismatch.' >&2
  exit 1
fi

cd "$repo_root"
npm ci --ignore-scripts --no-audit --no-fund
npm run vendor:pdfjs
npm test

mkdir -p "$work_dir"
ditto -x -k "$archive" "$work_dir"
mv "$work_dir/Electron.app" "$app"
resources="$app/Contents/Resources/app"
mkdir -p "$resources/node_modules"
for directory in desktop lib public licenses; do
  ditto "$repo_root/$directory" "$resources/$directory"
done
ditto "$repo_root/node_modules/ws" "$resources/node_modules/ws"
for file in server.mjs convert-presentation.applescript package.json package-lock.json LICENSE README.md; do
  cp "$repo_root/$file" "$resources/$file"
done

plist="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Theater Simple' "$plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Theater Simple' "$plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.vmihalis.theater-simple' "$plist"
/usr/libexec/PlistBuddy -c 'Add :NSMicrophoneUsageDescription string Theater Simple uses the selected microphone for live translated captions.' "$plist"
/usr/libexec/PlistBuddy -c 'Add :NSCameraUsageDescription string Theater Simple uses the camera only when you turn on its camera view.' "$plist"
/usr/libexec/PlistBuddy -c 'Add :NSAppleEventsUsageDescription string Theater Simple asks PowerPoint to export selected slides as PDF.' "$plist"
/usr/libexec/PlistBuddy -c 'Add :NSAudioCaptureUsageDescription string Theater Simple captures presentation pictures; system audio is not captured.' "$plist"
plutil -lint "$plist"

# Ad-hoc signing keeps the locally testable bundle internally consistent.
# A public production release needs an Apple Developer ID and notarization.
codesign --force --deep --sign - --timestamp=none "$app"
codesign --verify --deep --strict "$app"

cp "$repo_root/START HERE Mac.txt" "$work_dir/START HERE Mac.txt"
cp "$repo_root/LICENSE" "$work_dir/LICENSE.txt"
ditto -c -k --sequesterRsrc --keepParent "$work_dir" "$package"
hash="$(shasum -a 256 "$package" | awk '{print $1}')"
printf '%s  %s\n' "$hash" "$(basename "$package")" > "$package.sha256"
printf 'Mac package: %s\nSHA-256: %s\n' "$package" "$hash"
