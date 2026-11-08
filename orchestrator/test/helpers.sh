#!/usr/bin/env bash
# Tiny test harness. Sourced by every t_*.sh. Runs under Git Bash with jq; nothing here needs
# root, systemd, flock, git or a network: test/bin holds stubs for them.
# Never as root. The stubs in test/bin do not catch every call (sandbox.sh reaches the real
# systemd-run), so as root on a host with live lanes the suite acts on real units: a run as root on
# a live box once stopped a lane's factory-pg-s2 mid-issue and cost that issue its verify.
if [[ ${EUID:-$(id -u)} == 0 && ${FACTORY_TEST_AS_ROOT:-} != 1 ]]; then
  echo "refusing to run the orchestrator tests as root (they would touch real systemd units); run them as an unprivileged user" >&2
  exit 2
fi
TESTDIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ORCH=$(cd "$TESTDIR/.." && pwd)
FIX=$(cd "$ORCH/../contracts/fixtures" && pwd)
PASSN=0 FAILN=0
export PATH="$TESTDIR/bin:$PATH"

setup_env() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/factory-test.XXXXXX")
  export STATE=$T/state UI=$T/ui CTL=$T/ctl LOGDIR=$T/log H=$T/home BASE_DIR=$T/opt FILE_GROUP=
  export MIRROR=$T/opt/mirror.git GH=$TESTDIR/bin/gh
  mkdir -p "$STATE" "$UI/slots" "$CTL" "$LOGDIR" "$H" "$BASE_DIR" "$MIRROR"
  unset NOW || true
  trap 'rm -rf "$T"' EXIT
}

ok() { PASSN=$((PASSN + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAILN=$((FAILN + 1)); printf '  FAIL %s\n' "$1"; shift; if (( $# )); then printf '       %s\n' "$@"; fi; }

assert_eq() {  # name expected actual
  if [[ $2 == "$3" ]]; then ok "$1"; else bad "$1" "expected: $2" "actual:   $3"; fi
}
assert_json_eq() {  # name expected-json actual-json (compared canonically)
  local a b
  a=$(jq -S -c . <<<"$2" 2>&1) || a="invalid: $2"
  b=$(jq -S -c . <<<"$3" 2>&1) || b="invalid: $3"
  if [[ $a == "$b" ]]; then ok "$1"; else bad "$1" "expected: $a" "actual:   $b"; fi
}
assert_true() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name" "command failed: $*"; fi; }
assert_false() { local name=$1; shift; if "$@" >/dev/null 2>&1; then bad "$name" "command unexpectedly succeeded: $*"; else ok "$name"; fi; }

finish() {
  printf '%s: %d passed, %d failed\n' "$(basename "$0")" "$PASSN" "$FAILN"
  (( FAILN == 0 ))
}
