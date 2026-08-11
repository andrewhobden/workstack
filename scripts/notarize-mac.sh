#!/usr/bin/env bash
set -euo pipefail

app_path="dist/mac-arm64/Workstack.app"
archive_path="dist/Workstack-notarization.zip"
profile_name="workstack-notary"

if [[ ! -d "$app_path" ]]; then
  printf 'Signed app not found at %s. Run npm run package:mac first.\n' "$app_path" >&2
  exit 1
fi

rm -f "$archive_path"
ditto -c -k --keepParent "$app_path" "$archive_path"
xcrun notarytool submit "$archive_path" --keychain-profile "$profile_name" --wait
xcrun stapler staple "$app_path"
spctl --assess --type execute --verbose=4 "$app_path"
