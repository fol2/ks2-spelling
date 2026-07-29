#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
spike_dir="$repo_root/spikes/flutter_ks2_spelling"
expected_spike_dir="$repo_root/spikes/flutter_ks2_spelling"
[ "$spike_dir" = "$expected_spike_dir" ]
[ -d "$spike_dir/lib" ]
[ -f "$spike_dir/pubspec.yaml" ]
command -v flutter >/dev/null
command -v tar >/dev/null

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

# The committed source must compile before scaffolding as well as afterwards.
# Older spike commits kept the AttemptStore substitution as a transient build
# mutation, which meant a checkout was not independently runnable.
"$python_command" - "$python_path" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
old = 'final AttemptRepository repository;'
new = 'final AttemptStore repository;'
old_count = source.count(old)
new_count = source.count(new)
if old_count == 2 and new_count == 0:
    path.write_text(source.replace(old, new))
elif old_count == 0 and new_count == 2:
    pass
else:
    raise SystemExit(
        f'unexpected repository field topology: concrete={old_count}, interface={new_count}'
    )
PY

tar -czf "$archive" \
  -C "$spike_dir" \
  pubspec.yaml \
  analysis_options.yaml \
  README.md \
  lib \
  test
[ -s "$archive" ]

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
