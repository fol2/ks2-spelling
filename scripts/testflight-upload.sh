#!/usr/bin/env bash
# Archive and upload KS2 Spelling to TestFlight using App Store Connect API-key
# authentication as xcodebuild CLI flags. Lean Octomiser-shaped lane: no Sentry
# and no whale regression. Capacitor product assets are rebuilt inside a
# detached clean worktree before archive.

set -euo pipefail
set +x
set +o xtrace 2>/dev/null || true

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# Tested-working App Store Connect toolchain (DTXcode 2660 / Build 17F109 / iphoneos26.5).
# Beta Xcode paths are rejected by Apple at export ("Unsupported SDK or Xcode version").
PINNED_DEVELOPER_DIR="/Applications/Xcode-26.6.0-release.candidate.app/Contents/Developer"
DEFAULT_ASC_KEY_ID="NA8CPX2ZL2"
DEFAULT_ASC_ISSUER_ID="86050c03-0021-426c-8c9a-70965f016e81"

usage() {
  cat <<'USAGE'
Usage: scripts/testflight-upload.sh --version VERSION --build BUILD [options]

Options:
  --version VERSION            Marketing version, for example 0.5.0.
  --build BUILD                Build number, for example 1.
  --private-key-path PATH      AuthKey_*.p8 path. Defaults to ASC_PRIVATE_KEY_PATH
                               or ~/.appstoreconnect/private_keys/AuthKey_<key-id>.p8.
  --wait-for-valid             Poll App Store Connect until the build is VALID
                               (off by default; processing continues on Apple's side).
  --wait-attempts N            Poll attempts when --wait-for-valid is set. Defaults to 20.
  --wait-interval SECONDS      Poll interval when --wait-for-valid is set. Defaults to 30.
  --dry-run                    Validate inputs and print planned paths only.
  -h, --help                   Show this help.

Environment:
  DEVELOPER_DIR                Optional. Honoured when set; otherwise pinned to the
                               tested Xcode 26.6 RC toolchain (Apple rejects beta SDKs).
  ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH.
USAGE
}

log() { printf '[testflight-upload] %s\n' "$*"; }
fail() { printf '[testflight-upload] ERROR: %s\n' "$*" >&2; exit 1; }

need_value() {
  local option="$1" value="${2:-}"
  [[ -n "$value" ]] || fail "$option requires a value"
}

cleanup() {
  if [[ -n "${RELEASE_WORKTREE:-}" && -d "$RELEASE_WORKTREE" ]]; then
    /usr/bin/git -C "$ROOT_DIR" worktree remove --force "$RELEASE_WORKTREE" \
      >/dev/null 2>&1 || true
  fi
  if [[ -n "${RELEASE_WORKTREE_PARENT:-}" && -d "$RELEASE_WORKTREE_PARENT" ]]; then
    rm -rf "$RELEASE_WORKTREE_PARENT"
  fi
  return 0
}
trap cleanup EXIT

write_export_options() {
  local plist="$1"
  mkdir -p "$(dirname "$plist")"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key>
  <string>upload</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>stripSwiftSymbols</key>
  <true/>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
PLIST
}

resolve_developer_dir() {
  if [[ -z "${DEVELOPER_DIR:-}" ]]; then
    export DEVELOPER_DIR="$PINNED_DEVELOPER_DIR"
  fi
  local resolved="$DEVELOPER_DIR"
  if [[ -e "$DEVELOPER_DIR" ]]; then
    resolved="$(cd "$DEVELOPER_DIR" 2>/dev/null && pwd -P)" || resolved="$DEVELOPER_DIR"
  fi
  local installed
  installed="$(/bin/ls -d /Applications/Xcode*.app 2>/dev/null || true)"
  if [[ "$resolved" == *[Bb]eta* ]]; then
    fail "DEVELOPER_DIR resolves to a beta toolchain ($resolved); Apple rejects beta-built submissions. Fix: export DEVELOPER_DIR=$PINNED_DEVELOPER_DIR (or omit it to use the pin). Installed: ${installed:-none}"
  fi
  if [[ ! -d "$resolved" ]]; then
    fail "DEVELOPER_DIR does not exist ($resolved); expected the pinned RC at $PINNED_DEVELOPER_DIR. Fix: install that Xcode or export DEVELOPER_DIR to a non-beta toolchain. Installed: ${installed:-none}"
  fi
  log "DEVELOPER_DIR=$resolved"
}

verify_original_source() {
  /usr/bin/git -C "$ROOT_DIR" diff --quiet --ignore-submodules -- \
    || fail "release upload requires a clean worktree"
  /usr/bin/git -C "$ROOT_DIR" diff --cached --quiet --ignore-submodules -- \
    || fail "release upload requires a clean index"
  [[ -z "$(/usr/bin/git -C "$ROOT_DIR" ls-files --others --exclude-standard)" ]] \
    || fail "release upload requires all untracked files to be resolved"

  local current_head
  current_head="$(/usr/bin/git -C "$ROOT_DIR" rev-parse HEAD)"
  if [[ -z "$SOURCE_HEAD_SHA" ]]; then
    SOURCE_HEAD_SHA="$current_head"
  else
    [[ "$current_head" == "$SOURCE_HEAD_SHA" ]] \
      || fail "release HEAD changed during archive production"
  fi
}

create_release_worktree() {
  RELEASE_WORKTREE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/ks2-spelling-release-worktree.XXXXXX")"
  RELEASE_WORKTREE="$RELEASE_WORKTREE_PARENT/source"
  /usr/bin/git -C "$ROOT_DIR" worktree add --detach "$RELEASE_WORKTREE" "$SOURCE_HEAD_SHA" \
    >/dev/null
}

verify_release_worktree() {
  [[ "$(/usr/bin/git -C "$RELEASE_WORKTREE" rev-parse HEAD)" == "$SOURCE_HEAD_SHA" ]] \
    || fail "detached release worktree HEAD changed during archive production"
}

verify_project_version() {
  local project="$ROOT_DIR/$PROJECT_PATH/project.pbxproj"
  [[ -f "$project" ]] || fail "Xcode project missing: $project"
  /usr/bin/grep -Eq "MARKETING_VERSION = ${VERSION};" "$project" \
    || fail "project MARKETING_VERSION does not match --version ${VERSION}"
  /usr/bin/grep -Eq "CURRENT_PROJECT_VERSION = ${BUILD_NUMBER};" "$project" \
    || fail "project CURRENT_PROJECT_VERSION does not match --build ${BUILD_NUMBER} for the App target"
  /usr/bin/grep -Eq 'INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO;' "$project" \
    || fail "App target must declare INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO"
  log "PASS project version ${VERSION} (${BUILD_NUMBER}) and exempt encryption"
}

assert_product_composition() {
  local index_path="$1/ios/App/App/public/index.html"
  local cap_path="$1/ios/App/App/capacitor.config.json"
  [[ -f "$index_path" ]] || fail "synced product index missing: $index_path"
  [[ -f "$cap_path" ]] || fail "synced capacitor.config.json missing: $cap_path"
  if /usr/bin/grep -Eq 'B4Development|B3SandboxProof' "$index_path"; then
    fail "synced web payload is a proof composition; rebuild product with npm run build && npx cap sync ios"
  fi
  if /usr/bin/grep -Eq '"server"[[:space:]]*:|"server\.url"' "$cap_path"; then
    fail "synced capacitor.config.json must not set server.url for production"
  fi
  log "PASS product composition (no proof markers, no server.url)"
}

run_lean_readiness() {
  local worktree="$1"
  log "Running lean TestFlight readiness in detached worktree"
  (
    cd "$worktree"
    npm ci
    npm run build
    npx cap sync ios
    assert_product_composition "$worktree"
    node --test tests/ios-project-contract.test.mjs
    npm run test:fast
  )
  log "PASS lean readiness"
}

verify_archive_version() {
  local archive="$1"
  local plist="$archive/Products/Applications/${APP_PRODUCT_NAME}.app/Info.plist"
  [[ -f "$plist" ]] || fail "app Info.plist not found in archive: $plist"

  local actual_version actual_build
  actual_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")
  actual_build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")

  [[ "$actual_version" == "$VERSION" ]] || fail "archive version is $actual_version, expected $VERSION"
  [[ "$actual_build" == "$BUILD_NUMBER" ]] || fail "archive build is $actual_build, expected $BUILD_NUMBER"
  log "Archive version verified: ${actual_version} (${actual_build})"
}

distribution_log_dir_from() {
  sed -n 's/.*Created bundle at path "\([^"]*\.xcdistributionlogs\)".*/\1/p' "$1" | tail -n 1
}

assert_upload_clean() {
  local export_log="$1" distribution_log_dir="$2"

  /usr/bin/grep -Eq '\*\* EXPORT SUCCEEDED \*\*|Upload succeeded|Uploaded .+' "$export_log" \
    || fail "export log does not show a successful upload: $export_log"

  local paths=("$export_log")
  [[ -n "$distribution_log_dir" && -d "$distribution_log_dir" ]] && paths+=("$distribution_log_dir")
  if /usr/bin/grep -En 'Upload Symbols Failed|Asset validation failed|ERROR ITMS|EXPORT FAILED' "${paths[@]}" >/dev/null; then
    /usr/bin/grep -En 'Upload Symbols Failed|Asset validation failed|ERROR ITMS|EXPORT FAILED' "${paths[@]}" || true
    fail "upload completed with blocking export or validation errors"
  fi
  log "Upload logs show no blocking export, ITMS, or symbol-upload errors"
}

wait_for_valid_build() {
  local asc_log="$1"
  local attempt json state
  for ((attempt = 1; attempt <= WAIT_ATTEMPTS; attempt++)); do
    log "App Store Connect VALID check ${attempt}/${WAIT_ATTEMPTS}"
    if json="$(/opt/homebrew/bin/asc builds list --app "$ASC_APP_ID" --sort -uploadedDate --limit 20 --pretty 2>"$asc_log.err")"; then
      printf '%s\n' "$json" >"$asc_log"
      state="$(
        BUILD_NUMBER="$BUILD_NUMBER" /usr/bin/python3 -c '
import json, os, sys
data = json.load(sys.stdin)
want = os.environ["BUILD_NUMBER"]
for item in data.get("data", []):
    attrs = item.get("attributes", {})
    if str(attrs.get("version")) == want:
        print(attrs.get("processingState", ""))
        break
' <<<"$json"
      )"
      if [[ "$state" == "VALID" ]]; then
        log "App Store Connect build is VALID"
        return
      fi
      log "Build processingState=${state:-unknown}"
    else
      log "asc builds list failed; see ${asc_log}.err"
    fi
    sleep "$WAIT_INTERVAL"
  done
  fail "App Store Connect build did not reach VALID within ${WAIT_ATTEMPTS} attempts"
}

verify_release_environment() {
  local probe_dir probe_bin codesign_identity avail_gib manager_name

  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/ks2-spelling-keychain-probe.XXXXXX")" \
    || fail "could not create a temporary directory for the keychain signing probe"
  probe_bin="$probe_dir/true"
  /bin/cp /usr/bin/true "$probe_bin" \
    || {
      rm -rf "$probe_dir"
      fail "could not stage the keychain signing probe binary"
    }
  codesign_identity="$(
    /usr/bin/security find-identity -v -p codesigning 2>/dev/null \
      | /usr/bin/sed -n 's/^ *[0-9][0-9]*) [^ ]* "\(Apple Development: .*\)"$/\1/p' \
      | /usr/bin/head -n 1
  )"
  [[ -n "$codesign_identity" ]] \
    || {
      rm -rf "$probe_dir"
      fail "no Apple Development codesigning identity available in the login keychain"
    }
  if ! /usr/bin/codesign --force -s "$codesign_identity" "$probe_bin" \
      >/dev/null 2>&1; then
    rm -rf "$probe_dir"
    manager_name="$(/bin/launchctl managername 2>/dev/null || printf 'unknown')"
    fail "login keychain appears locked or the Apple Development signing identity is unavailable (launchctl managername=${manager_name}); unlock the login keychain in this process tree before retrying"
  fi
  rm -rf "$probe_dir"
  log "PASS env keychain-signing"

  avail_gib="$(/bin/df -g "$ROOT_DIR" | awk 'NR == 2 { print $4; exit }')"
  [[ "$avail_gib" =~ ^[0-9]+$ ]] \
    || fail "could not determine free disk space for the repository filesystem"
  [[ "$avail_gib" -ge 20 ]] \
    || fail "insufficient free disk space for release upload: ${avail_gib} GiB available, need at least 20 GiB"
  log "PASS env disk-space"

  /usr/bin/git -C "$ROOT_DIR" worktree prune >/dev/null 2>&1 || true
  log "PASS env worktree-prune"
}

VERSION=""
BUILD_NUMBER=""
PRIVATE_KEY_PATH="${ASC_PRIVATE_KEY_PATH:-}"
WAIT_FOR_VALID=0
WAIT_ATTEMPTS=20
WAIT_INTERVAL=30
DRY_RUN=0
SOURCE_HEAD_SHA=""
RELEASE_WORKTREE_PARENT=""
RELEASE_WORKTREE=""

APP_PRODUCT_NAME="App"
CONFIGURATION="Release"
DESTINATION="generic/platform=iOS"
PROJECT_PATH="ios/App/App.xcodeproj"
SCHEME="KS2Spelling"
TEAM_ID="V45S7U2LZB"
ASC_APP_ID="${ASC_APP_ID:-}"
BUILD_ROOT="$ROOT_DIR/build"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) need_value "$1" "${2:-}"; VERSION="$2"; shift ;;
    --version=*) VERSION="${1#*=}" ;;
    --build) need_value "$1" "${2:-}"; BUILD_NUMBER="$2"; shift ;;
    --build=*) BUILD_NUMBER="${1#*=}" ;;
    --private-key-path) need_value "$1" "${2:-}"; PRIVATE_KEY_PATH="$2"; shift ;;
    --private-key-path=*) PRIVATE_KEY_PATH="${1#*=}" ;;
    --wait-for-valid) WAIT_FOR_VALID=1 ;;
    --wait-attempts) need_value "$1" "${2:-}"; WAIT_ATTEMPTS="$2"; shift ;;
    --wait-attempts=*) WAIT_ATTEMPTS="${1#*=}" ;;
    --wait-interval) need_value "$1" "${2:-}"; WAIT_INTERVAL="$2"; shift ;;
    --wait-interval=*) WAIT_INTERVAL="${1#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] \
  || fail "--version must contain two or three numeric components"
[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || fail "--build must be numeric"
[[ "$WAIT_ATTEMPTS" =~ ^[0-9]+$ && "$WAIT_ATTEMPTS" -gt 0 ]] || fail "--wait-attempts must be a positive integer"
[[ "$WAIT_INTERVAL" =~ ^[0-9]+$ ]] || fail "--wait-interval must be a non-negative integer"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry-run preflight: validating inputs without resolving toolchain"
  cd "$ROOT_DIR"
  verify_original_source
  verify_project_version
  log "Version/build: ${VERSION} (${BUILD_NUMBER})"
  log "Dry run complete; toolchain resolution and other checks were skipped"
  exit 0
fi

resolve_developer_dir

cd "$ROOT_DIR"
verify_original_source
verify_project_version
verify_release_environment

KEY_ID="${ASC_KEY_ID:-$DEFAULT_ASC_KEY_ID}"
ISSUER_ID="${ASC_ISSUER_ID:-$DEFAULT_ASC_ISSUER_ID}"

if [[ -n "$PRIVATE_KEY_PATH" ]]; then
  PRIVATE_KEY_PATH="$(cd "$(dirname "$PRIVATE_KEY_PATH")" && pwd -P)/$(basename "$PRIVATE_KEY_PATH")"
elif [[ -f "$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8" ]]; then
  PRIVATE_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
else
  fail "private key path is required; set ASC_PRIVATE_KEY_PATH or keep AuthKey_${KEY_ID}.p8 under ~/.appstoreconnect/private_keys"
fi
[[ -f "$PRIVATE_KEY_PATH" ]] || fail "private key file not found: $PRIVATE_KEY_PATH"

if [[ -z "$ASC_APP_ID" ]]; then
  ASC_APP_ID="$(
    /opt/homebrew/bin/asc apps list --bundle-id uk.eugnel.ks2spelling --pretty 2>/dev/null \
      | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"][0]["id"] if d.get("data") else "")'
  )" || ASC_APP_ID=""
fi
if [[ -z "$ASC_APP_ID" ]]; then
  log "WARN: ASC app for uk.eugnel.ks2spelling not found yet; upload may still create/process against the bundle id, but --wait-for-valid requires the app record"
  if [[ "$WAIT_FOR_VALID" -eq 1 ]]; then
    fail "ASC app for uk.eugnel.ks2spelling not found; create it before --wait-for-valid"
  fi
fi

STAMP="$(date +%Y%m%d%H%M%S)"
RUN_LABEL="${VERSION}-${BUILD_NUMBER}-${STAMP}"
ARCHIVE_PATH="${BUILD_ROOT}/archives/KS2Spelling-${VERSION}-${BUILD_NUMBER}-${STAMP}.xcarchive"
EXPORT_PATH="${BUILD_ROOT}/export/KS2Spelling-${VERSION}-${BUILD_NUMBER}-${STAMP}"
EXPORT_OPTIONS_PLIST="${BUILD_ROOT}/export/TestFlightUploadOptions-${VERSION}-${BUILD_NUMBER}-${STAMP}.plist"
ARCHIVE_LOG="${BUILD_ROOT}/logs/archive-${RUN_LABEL}.log"
EXPORT_LOG="${BUILD_ROOT}/logs/export-upload-${RUN_LABEL}.log"
ASC_LOG="${BUILD_ROOT}/logs/asc-valid-${RUN_LABEL}.log"
READINESS_LOG="${BUILD_ROOT}/logs/readiness-${RUN_LABEL}.log"

AUTH_ARGS=(
  -authenticationKeyPath "$PRIVATE_KEY_PATH"
  -authenticationKeyID "$KEY_ID"
  -authenticationKeyIssuerID "$ISSUER_ID"
)

mkdir -p "${BUILD_ROOT}/archives" "${BUILD_ROOT}/export" "${BUILD_ROOT}/logs"
write_export_options "$EXPORT_OPTIONS_PLIST"
create_release_worktree

log "Lean readiness + product sync in detached worktree"
set -o pipefail
set +e
run_lean_readiness "$RELEASE_WORKTREE" 2>&1 | tee "$READINESS_LOG"
readiness_status=${PIPESTATUS[0]}
set -e
[[ "$readiness_status" -eq 0 ]] || fail "lean readiness failed; see $READINESS_LOG"

verify_original_source
verify_release_worktree

log "Archiving detached clean product source"
printf 'ARCHIVE_PATH=%s\nLOG_PATH=%s\nSTARTED_AT=%s\nSOURCE_HEAD_SHA=%s\n' \
  "$ARCHIVE_PATH" "$ARCHIVE_LOG" "$STAMP" "$SOURCE_HEAD_SHA" \
  >"${BUILD_ROOT}/logs/latest-${VERSION}-${BUILD_NUMBER}-archive.env"
set -o pipefail
set +e
(
  cd "$RELEASE_WORKTREE"
  /usr/bin/xcrun xcodebuild archive \
    -project "$PROJECT_PATH" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -destination "$DESTINATION" \
    -archivePath "$ARCHIVE_PATH" \
    -allowProvisioningUpdates \
    "${AUTH_ARGS[@]}"
) 2>&1 | tee "$ARCHIVE_LOG"
archive_status=${PIPESTATUS[0]}
set -e
printf 'EXIT_CODE=%s\n' "$archive_status" \
  >>"${BUILD_ROOT}/logs/latest-${VERSION}-${BUILD_NUMBER}-archive.env"
[[ "$archive_status" -eq 0 ]] || exit "$archive_status"

verify_original_source
verify_release_worktree
verify_archive_version "$ARCHIVE_PATH"

log "Exporting and uploading"
printf 'ARCHIVE_PATH=%s\nEXPORT_PATH=%s\nEXPORT_OPTIONS_PLIST=%s\nLOG_PATH=%s\nSTARTED_AT=%s\nAUTH=api-key-cli\nSOURCE_HEAD_SHA=%s\nASC_APP_ID=%s\n' \
  "$ARCHIVE_PATH" "$EXPORT_PATH" "$EXPORT_OPTIONS_PLIST" "$EXPORT_LOG" "$STAMP" \
  "$SOURCE_HEAD_SHA" "$ASC_APP_ID" \
  >"${BUILD_ROOT}/logs/latest-${VERSION}-${BUILD_NUMBER}-export.env"
set -o pipefail
set +e
/usr/bin/xcrun xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS_PLIST" \
  -allowProvisioningUpdates \
  "${AUTH_ARGS[@]}" 2>&1 | tee "$EXPORT_LOG"
export_status=${PIPESTATUS[0]}
set -e
printf 'EXIT_CODE=%s\n' "$export_status" \
  >>"${BUILD_ROOT}/logs/latest-${VERSION}-${BUILD_NUMBER}-export.env"
[[ "$export_status" -eq 0 ]] || exit "$export_status"

assert_upload_clean "$EXPORT_LOG" "$(distribution_log_dir_from "$EXPORT_LOG")"
if [[ "$WAIT_FOR_VALID" -eq 0 ]]; then
  log "Upload accepted; App Store Connect processing continues on Apple's side"
else
  wait_for_valid_build "$ASC_LOG"
fi
log "Done"
