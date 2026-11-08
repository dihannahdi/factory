#!/usr/bin/env bash
# Shared by G1..G4. Run as root on the box AFTER deploy/orchestrator-install.sh and BEFORE the
# lanes are enabled (or while they are idle). Every gate cleans up after itself and only touches
# scratch directories (s9 and s<K>/gate*) and its own transient units (factory-sb-*-g<N>-*).
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 2; }

BASE=${BASE_DIR:-/opt/factory}
SANDBOX=${SANDBOX:-$BASE/sandbox.sh}
H=/home/factory
UI=/var/lib/factory-ops/ui
EVID=$(mktemp -d /root/factory-gate.XXXXXX)
FAILED=0

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILED=1; }
note() { echo "  evidence: $*"; }

# Model for the calls: $GATE_MODEL, else the first free model that does not train on prompts,
# else the first free one. These gates send one-line prompts only.
free_model() {
  if [[ -n ${GATE_MODEL:-} ]]; then echo "$GATE_MODEL"; return; fi
  jq -r '(([.free[] | select(.trains_on_data == false)] | first) // .free[0] // empty) | .id' "$UI/models.json" 2>/dev/null
}

# gate_dir <K>: a scratch working directory inside lane K's home, owned by the agent.
gate_dir() {
  install -d -o factory -g factory "$H/s$1" "$H/s$1/gate"
  echo "$H/s$1/gate"
}
gate_rm() {  # as the agent, inside the sandbox: root never rm -rf's inside the agent's home
  SB_GATE=1 SB_SLOT=$1 "$SANDBOX" "$H/s$1" 60 rm -rf -- "$H/s$1/gate" </dev/null >/dev/null 2>&1 || true
}

# oc_run <K> <unit-suffix> <timeout> <out-prefix> <args...>: opencode run inside lane K's
# sandbox, in the background of THIS shell (so `wait` works); sets OC_PID. Output goes to
# <out-prefix>.jsonl / .err and the exit code to .rc. Never call it inside $(...).
oc_run() {
  local k=$1 unit=$2 tmo=$3 out=$4; shift 4
  (
    SB_GATE=1 SB_SLOT=$k SB_UNIT=factory-sb-$k-$unit "$SANDBOX" "$H/s$k/gate" "$tmo" opencode run --auto --format json "$@"       </dev/null > "$out.jsonl" 2> "$out.err"
    echo $? > "$out.rc"
  ) >/dev/null 2>&1 &
  OC_PID=$!
}

events() { jq -c -R 'fromjson? // empty' "$1" 2>/dev/null; }
errors_in() { events "$1" | jq -c 'select(.type == "error")'; }
session_of() { events "$1" | jq -r -s 'map(.sessionID // .part.sessionID // empty) | first // empty'; }

finish() {
  rm -rf "$EVID"
  if (( FAILED )); then echo "RESULT: FAIL"; else echo "RESULT: PASS"; fi
  exit "$FAILED"
}
