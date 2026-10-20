#!/bin/bash
# Run after building the signed universal MAS package. Never enable shell tracing.
set -euo pipefail
for name in ASC_KEY_ID ASC_ISSUER_ID ASC_APP_ID ASC_API_KEY_P8; do
  [ -n "${!name:-}" ] || { echo "Missing upload configuration: $name" >&2; exit 1; }
done
[[ "$ASC_KEY_ID" =~ ^[A-Za-z0-9]+$ ]] || { echo 'Invalid API key ID' >&2; exit 1; }
[[ "$ASC_APP_ID" =~ ^[0-9]+$ ]] || { echo 'App ID must be the numeric App Store Connect Apple ID' >&2; exit 1; }
shopt -s nullglob
packages=(release/mas-universal/*.pkg)
[ "${#packages[@]}" = 1 ] || { echo 'Expected exactly one signed universal .pkg' >&2; exit 1; }
plist=release/mas-universal/Hasht.app/Contents/Info.plist
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")
API_PRIVATE_KEYS_DIR=$(mktemp -d "${TMPDIR:-/tmp}/hasht-asc.XXXXXX")
export API_PRIVATE_KEYS_DIR
trap 'rm -rf "$API_PRIVATE_KEYS_DIR"' EXIT
umask 077
printf '%s' "$ASC_API_KEY_P8" > "$API_PRIVATE_KEYS_DIR/AuthKey_$ASC_KEY_ID.p8"
unset ASC_API_KEY_P8
xcrun altool --validate-app -f "${packages[0]}" -t macos \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
xcrun altool --upload-package "${packages[0]}" -t macos \
  --apple-id "$ASC_APP_ID" --bundle-id "$bundle_id" \
  --bundle-short-version-string "$version" --bundle-version "$build" \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
echo 'Uploaded to App Store Connect; Apple processing and TestFlight availability are pending.'
