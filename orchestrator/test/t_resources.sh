#!/usr/bin/env bash
# Resource guards added after 2026-10-18 (sandbox OOM kills + a full shared disk): the per-lane
# cargo target cap and recognising a sandbox that hit its memory cap.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u

K=1 SLOTDIR=$T/s1 AGENT_OWNER="$(id -un)"
mkdir -p "$SLOTDIR/target/debug"

echo "target_trim"
printf 'x' > "$SLOTDIR/target/debug/small.rlib"
TARGET_MAX_GB=5 target_trim
assert_true "under the cap: kept" test -f "$SLOTDIR/target/debug/small.rlib"
TARGET_MAX_GB=0 target_trim
assert_false "over the cap: emptied" test -e "$SLOTDIR/target/debug/small.rlib"
assert_true "the directory itself is recreated" test -d "$SLOTDIR/target"
mkdir -p "$T/elsewhere"; printf 'keep' > "$T/elsewhere/file"
rm -rf "$SLOTDIR/target"; ln -s "$T/elsewhere" "$SLOTDIR/target" 2>/dev/null
if [[ -L $SLOTDIR/target ]]; then
  TARGET_MAX_GB=0 target_trim
  assert_true "a symlinked target is never followed" test -f "$T/elsewhere/file"
else
  echo "  skip symlink case (no symlinks on this filesystem)"
fi

echo "unit_hit_memory_cap"
SB_MEMORY_MAX_GB=8
J=$T/journal; export FAKE_JOURNAL_FILE=$J
printf '%s\n' "factory-sb-1-x.service: Failed with result 'oom-kill'." "factory-sb-1-x.service: Consumed 46min CPU time, 8G memory peak, 996.4M memory swap peak." > "$J"
assert_true "oom-kill is a memory cap" unit_hit_memory_cap factory-sb-1-x
printf '%s\n' "factory-sb-1-y.service: Failed with result 'exit-code'." "factory-sb-1-y.service: Consumed 2h 13min CPU time, 8G memory peak, 252.8M memory swap peak." > "$J"
assert_true "peak at MemoryMax with exit-code is a memory cap" unit_hit_memory_cap factory-sb-1-y
printf '%s\n' "factory-sb-1-z.service: Failed with result 'exit-code'." "factory-sb-1-z.service: Consumed 12min CPU time, 1.7G memory peak." > "$J"
assert_false "a 1.7G peak is not" unit_hit_memory_cap factory-sb-1-z
rm -f "$J"
assert_false "no journal entry: not a memory cap" unit_hit_memory_cap factory-sb-1-gone
assert_false "no unit name: not a memory cap" unit_hit_memory_cap ""

finish
