#!/usr/bin/env bash
# Runs every orchestrator test. Needs bash 4.4+ and jq; no root, no systemd, no network, no git:
# test/bin holds stubs for flock, systemctl, git, gh, curl and a CRLF-stripping jq shim.
#   orchestrator/test/run-all.sh [t_name.sh ...]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ORCH=$(cd .. && pwd)
fails=0

echo "== syntax (bash -n)"
for f in "$ORCH"/lib.sh "$ORCH"/run.sh "$ORCH"/sync.sh "$ORCH"/sandbox.sh "$ORCH"/gates/*.sh "$ORCH"/../deploy/orchestrator-install.sh "$ORCH"/../deploy/instance-install.sh ./*.sh ./bin/fake-sandbox.sh; do
  if bash -n "$f" 2>/tmp/bashn.err; then echo "  ok   $(basename "$f")"; else echo "  FAIL $f"; cat /tmp/bashn.err; fails=$((fails + 1)); fi
done

tests=("$@")
if (( ${#tests[@]} == 0 )); then tests=(t_*.sh); fi
for t in "${tests[@]}"; do
  echo "== $t"
  if ! bash "$t"; then fails=$((fails + 1)); fi
done
echo
if (( fails == 0 )); then echo "ALL PASSED"; else echo "$fails FAILED"; exit 1; fi
