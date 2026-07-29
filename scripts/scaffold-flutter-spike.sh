#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
spike_dir="$repo_root/spikes/flutter_ks2_spelling"
expected_spike_dir="$repo_root/spikes/flutter_ks2_spelling"
[ "$spike_dir" = "$expected_spike_dir" ]
[ -d "$spike_dir/lib" ]
[ -f "$spike_dir/pubspec.yaml" ]
[ -f "$spike_dir/pubspec.lock" ]
command -v flutter >/dev/null
command -v tar >/dev/null
command -v cmp >/dev/null

temp_root="${RUNNER_TEMP:-/tmp}"
if command -v cygpath >/dev/null 2>&1; then
  temp_root="$(cygpath -u "$temp_root")"
fi
mkdir -p "$temp_root"
archive="$temp_root/ks2-spelling-flutter-source-$$.tgz"
trap 'rm -f "$archive"' EXIT

source_path="$spike_dir/lib/spelling_spike_app.dart"
python_path="$source_path"
if command -v cygpath >/dev/null 2>&1; then
  python_path="$(cygpath -w "$source_path")"
fi
python_command="python3"
if ! command -v "$python_command" >/dev/null 2>&1; then
  python_command="python"
fi
command -v "$python_command" >/dev/null

# Regeneration must never repair or rewrite committed source. The checkout must
# already expose the interface at both application boundaries; otherwise fail
# before removing any generated shell.
"$python_command" - "$python_path" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
concrete = source.count('final AttemptRepository repository;')
interface = source.count('final AttemptStore repository;')
if concrete != 0 or interface != 2:
    raise SystemExit(
        f'unexpected repository field topology: concrete={concrete}, interface={interface}'
    )
PY

tar -czf "$archive" \
  -C "$spike_dir" \
  pubspec.yaml \
  pubspec.lock \
  analysis_options.yaml \
  README.md \
  lib \
  test
[ -s "$archive" ]

case "$spike_dir" in
  "$repo_root"/spikes/flutter_ks2_spelling) ;;
  *)
    echo "Refusing to replace unexpected path: $spike_dir" >&2
    exit 1
    ;;
esac
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

source_audio="$repo_root/content/full-pack/audio/iapetus/accident/word.m4a"
destination_audio="$spike_dir/assets/audio/accident-word.m4a"
[ -s "$source_audio" ]
mkdir -p "$(dirname "$destination_audio")"
cp "$source_audio" "$destination_audio"
cmp -s "$source_audio" "$destination_audio"
