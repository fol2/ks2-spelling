#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
spike_dir="$repo_root/spikes/flutter_ks2_spelling"
temp_root="${RUNNER_TEMP:-/tmp}"
if command -v cygpath >/dev/null 2>&1; then
  temp_root="$(cygpath -u "$temp_root")"
fi
archive="$temp_root/ks2-spelling-flutter-source.tgz"

rm -f "$archive"
tar -czf "$archive" \
  -C "$spike_dir" \
  pubspec.yaml \
  analysis_options.yaml \
  README.md \
  lib \
  test

rm -rf "$spike_dir"
flutter create \
  --empty \
  --no-pub \
  --org uk.eugnel \
  --project-name ks2_spelling_spike \
  --platforms android,ios,linux,macos,windows \
  "$spike_dir"

rm -rf "$spike_dir/lib" "$spike_dir/test"
tar -xzf "$archive" -C "$spike_dir"
mkdir -p "$spike_dir/assets/audio"
cp \
  "$repo_root/content/full-pack/audio/iapetus/accident/word.m4a" \
  "$spike_dir/assets/audio/accident-word.m4a"
rm -f "$archive"
