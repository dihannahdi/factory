#!/usr/bin/env bash
# G2: three concurrent `opencode run` (free model, trivial prompt) in s1..s3 with snapshots off
# finish without errors, and each session can then be resumed from a DIFFERENT lane (the
# opencode data dir is shared on purpose). Root, on the box. Uses s<K>/gate; cleans up.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

model=$(free_model)
[[ -n $model ]] || { fail "no free model in $UI/models.json (is sync running?)"; finish; }
echo "model: $model"
cleanup() { for k in 1 2 3; do gate_rm "$k"; done; rm -rf "$EVID"; }
trap cleanup EXIT
for k in 1 2 3; do gate_dir "$k" >/dev/null; done

echo "== snapshots off in the effective config"
cfg=$(SB_GATE=1 SB_SLOT=1 "$SANDBOX" "$H/s1/gate" 60 opencode debug config </dev/null 2>&1)
snap=$(jq -r '[.snapshot, .snapshots] | map(tostring) | join(",")' <<<"$cfg" 2>/dev/null)
note "opencode debug config: snapshot,snapshots = ${snap:-<unparsable>}"
if jq -e '.snapshot == false' <<<"$cfg" >/dev/null 2>&1; then pass "snapshot is false in the effective config"; else fail "snapshot is not false: ${snap:-unparsable config}"; fi

echo "== three concurrent runs"
pids=()
for k in 1 2 3; do
  oc_run "$k" "g2-$$" 600 "$EVID/run$k" -m "$model" --title "gate2 s$k" "Reply with exactly one word: ok"; pids+=("$OC_PID")
done
wait "${pids[@]}" 2>/dev/null
sids=()
for k in 1 2 3; do
  rc=$(cat "$EVID/run$k.rc" 2>/dev/null || echo "?")
  sid=$(session_of "$EVID/run$k.jsonl")
  errs=$(errors_in "$EVID/run$k.jsonl" | head -n 2)
  note "s$k: rc=$rc session=$sid events=$(events "$EVID/run$k.jsonl" | wc -l) cost=$(events "$EVID/run$k.jsonl" | jq -s '[.[] | select(.type=="step_finish") | .part.cost // 0] | add // 0')"
  if [[ $rc == 0 && -n $sid && -z $errs ]]; then pass "s$k completed without errors"; else fail "s$k: rc=$rc sid='$sid' errors: ${errs:-none} stderr: $(head -c 300 "$EVID/run$k.err")"; fi
  sids[$k]=$sid
done

echo "== resume each session from a different lane"
for k in 1 2 3; do
  other=$(( k % 3 + 1 ))
  [[ -n ${sids[$k]:-} ]] || { fail "no session from s$k to resume"; continue; }
  oc_run "$other" "g2r-$$-$k" 600 "$EVID/res$k" -s "${sids[$k]}" -m "$model" "Reply with exactly one word: again"
  wait "$OC_PID" 2>/dev/null
  rc=$(cat "$EVID/res$k.rc" 2>/dev/null || echo "?")
  errs=$(errors_in "$EVID/res$k.jsonl" | head -n 2)
  note "session of s$k resumed in s$other: rc=$rc same-session=$([[ $(session_of "$EVID/res$k.jsonl") == "${sids[$k]}" ]] && echo yes || echo no)"
  if [[ $rc == 0 && -z $errs ]]; then pass "session from s$k resumes in s$other"; else fail "resume s$k -> s$other: rc=$rc errors: ${errs:-none} stderr: $(head -c 300 "$EVID/res$k.err")"; fi
done

finish
