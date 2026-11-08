#!/usr/bin/env bash
# G4: three parallel trivial calls to the free model; prints every error JSON shape so rate-limit
# detection (err_class in lib.sh: statusCode 429 or a message that says so) can be calibrated
# against what Zen really sends. Root, on the box. Uses s1..s3/gate; cleans up.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE=$EVID/state UI=$UI source "$HERE/lib.sh" 2>/dev/null || fail "cannot source lib.sh next to the gates"

model=$(free_model)
[[ -n $model ]] || { fail "no free model in $UI/models.json (is sync running?)"; finish; }
echo "model: $model"
cleanup() { for k in 1 2 3; do gate_rm "$k"; done; rm -rf "$EVID"; }
trap cleanup EXIT
for k in 1 2 3; do gate_dir "$k" >/dev/null; done

pids=()
for k in 1 2 3; do
  oc_run "$k" "g4-$$" 300 "$EVID/call$k" -m "$model" --title "gate4 s$k" "Reply with exactly one word: ok"; pids+=("$OC_PID")
done
wait "${pids[@]}" 2>/dev/null

bad=0
for k in 1 2 3; do
  rc=$(cat "$EVID/call$k.rc" 2>/dev/null || echo "?")
  n_err=$(errors_in "$EVID/call$k.jsonl" | grep -c . || true)
  cls=none
  if declare -F err_class >/dev/null; then cls=$(err_class "$EVID/call$k.jsonl"); fi
  note "call $k: rc=$rc error-events=$n_err err_class=$cls stderr-bytes=$(wc -c < "$EVID/call$k.err")"
  if [[ $n_err -gt 0 ]]; then
    bad=1
    echo "  ERROR SHAPE (call $k):"
    errors_in "$EVID/call$k.jsonl" | head -n 3 | sed 's/^/    /' | cut -c1-600
    note "keys: $(errors_in "$EVID/call$k.jsonl" | head -n 1 | jq -c '[paths(scalars) | map(tostring) | join(".")]' 2>/dev/null)"
  fi
  if [[ -s $EVID/call$k.err ]]; then echo "  stderr (call $k): $(head -c 400 "$EVID/call$k.err" | tr '\n' ' ')"; fi
done

if (( bad == 0 )); then
  pass "three parallel calls, no error events (nothing to calibrate against yet; re-run when rate-limited, or inspect real error events with: grep -h '\"type\":\"error\"' /var/log/factory/issue-*/*.jsonl | head)"
else
  fail "at least one call returned an error event: compare the shapes above with err_class (statusCode 429 / message text) and adjust lib.sh err_class if they differ"
fi
finish
