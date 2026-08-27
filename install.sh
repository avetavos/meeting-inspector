#!/bin/bash
# Installs the latest Meeting Inspector release into /Applications.
#
#   curl -fsSL https://raw.githubusercontent.com/avetavos/meeting-inspector/main/install.sh | bash
#
# The app is not notarized, and a browser marks anything it downloads with a
# quarantine flag that macOS 15+ refuses to open past — with no way through in the
# dialog, since Apple removed the right-click bypass. Quarantine comes from the
# downloading application, not from macOS, so fetching the release with curl skips
# the whole problem rather than working around it afterwards.
set -euo pipefail

REPO="avetavos/meeting-inspector"
APP="/Applications/Meeting Inspector.app"

die() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
say() { printf '  %s\n' "$1"; }

[ "$(uname -s)" = "Darwin" ] || die "Meeting Inspector is macOS only."
[ "$(uname -m)" = "arm64" ] || die "Meeting Inspector needs an Apple Silicon Mac (M1 or later)."
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ] || die "Meeting Inspector needs macOS 13 or later."

echo "Meeting Inspector"

url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | cut -d'"' -f4)
[ -n "$url" ] || die "Could not find a .dmg in the latest release of $REPO."

work=$(mktemp -d)
mnt="$work/volume"
cleanup() {
  # Detach before removing the directory the volume is mounted inside, or rm walks
  # into a read-only mount and fails on every file in the bundle.
  hdiutil detach -quiet -force "$mnt" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

say "Downloading $(basename "$url")…"
curl -fL# -o "$work/app.dmg" "$url"

say "Mounting…"
# An explicit mount point, rather than parsing hdiutil's output — which prints
# nothing at all under -quiet, so there was nothing to parse.
hdiutil attach -nobrowse -quiet -readonly -mountpoint "$mnt" "$work/app.dmg" \
  || die "Could not mount the disk image."

src=$(find "$mnt" -maxdepth 1 -name '*.app' -print -quit)
[ -n "$src" ] || die "No application found inside the disk image."

if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
  say "Quitting the running copy…"
  osascript -e 'quit app "Meeting Inspector"' 2>/dev/null || true
  sleep 2
fi

say "Installing to /Applications…"
rm -rf "$APP"
# ditto, not cp: a plain recursive copy breaks the bundle's code signature.
ditto "$src" "$APP"

codesign --verify --strict "$APP" 2>/dev/null || die "The installed app failed signature verification."

printf '\n  Installed. Opening it now.\n'
printf '  First run asks for Microphone and Screen Recording, then offers to download\n'
printf '  the speech models (~3.1 GB). System audio is tied to Screen Recording — that\n'
printf '  is how it hears everyone else; the video stream is discarded immediately.\n\n'
open "$APP"
