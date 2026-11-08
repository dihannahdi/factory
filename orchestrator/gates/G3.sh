#!/usr/bin/env bash
# G3: a turn that is inside `bash -c 'sleep 120'` is cut with SIGINT (then again with SIGTERM) on
# the unit's main process after 20 s; `opencode run -s <sid>` must then continue without a 400.
# This is the assumption behind the steer design (soft kill + resume). Root, on the box. Uses
# s1/gate; run it while lane 1 is idle. Cleans up.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

model=$(free_model)
[[ -n $model ]] || { fail "no free model in $UI/models.json (is sync running?)"; finish; }
echo "model: $model"
cleanup() { systemctl stop factory-s1.slice >/dev/null 2>&1; gate_rm 1; rm -rf "$EVID"; }
trap cleanup EXIT

# in_unit_sleep <unit>: rc 0 when a `sleep 120` process lives in that unit's cgroup
in_unit_sleep() {
  local p
  for p in $(pgrep -f 'sleep 120' 2>/dev/null); do
    if grep -q -- "$1" "/proc/$p/cgroup" 2>/dev/null; then return 0; fi
  done
  return 1
}

for sig in INT TERM; do
  echo "== soft kill with SIG$sig, then resume"
  gate_rm 1
  gate_dir 1 >/dev/null
  unit=factory-sb-1-g3-$sig-$$
  out=$EVID/turn-$sig
  t0=$(date +%s)
  oc_run 1 "g3-$sig-$$" 900 "$out" -m "$model" --title "gate3 $sig"     "Run exactly this one bash command and wait for it to finish: sleep 120. When it is done, reply only: done. Do nothing else."
  pid=$OC_PID
  seen=0
  for i in $(seq 1 90); do
    if in_unit_sleep "$unit"; then seen=1; break; fi
    sleep 1
  done
  if (( seen == 0 )); then
    fail "SIG$sig: the model never started the sleep (inconclusive; unit cgroup: $(systemctl show -p ControlGroup --value "$unit.service" 2>/dev/null)); first events: $(events "$out.jsonl" | head -n 3 | cut -c1-200 | tr '\n' '|')"
    systemctl stop "$unit.service" >/dev/null 2>&1
    wait "$pid" 2>/dev/null
    continue
  fi
  # at least 20 s into the turn, with the tool call running
  while (( $(date +%s) - t0 < 20 )); do sleep 1; done
  note "sleep 120 is running in $unit; sending SIG$sig to the main process"
  systemctl kill --kill-whom=main -s "$sig" "$unit.service"
  for i in $(seq 1 5); do kill -0 "$pid" 2>/dev/null || break; sleep 2; done
  if kill -0 "$pid" 2>/dev/null; then note "client still alive after 10 s: stopping the unit"; systemctl stop "$unit.service" >/dev/null 2>&1; fi
  wait "$pid" 2>/dev/null
  sid=$(session_of "$out.jsonl")
  note "cut turn: rc=$(cat "$out.rc" 2>/dev/null) session=$sid events=$(events "$out.jsonl" | wc -l) last=$(events "$out.jsonl" | tail -n 1 | jq -c '{type, tool: .part.tool, status: .part.state.status}' 2>/dev/null)"
  note "leftover sleep in the cgroup: $(in_unit_sleep "$unit" && echo YES || echo no)"
  if [[ -z $sid ]]; then fail "SIG$sig: no session id in the cut turn's output, so there is nothing to resume"; continue; fi

  SB_GATE=1 SB_SLOT=1 "$SANDBOX" "$H/s1/gate" 30 rm -f .git/index.lock </dev/null >/dev/null 2>&1
  oc_run 1 "g3r-$sig-$$" 600 "$EVID/resume-$sig" -s "$sid" -m "$model"     "Steer from a human: ignore the sleep command that was cut off. Reply with exactly one word: continue"
  wait "$OC_PID" 2>/dev/null
  rc=$(cat "$EVID/resume-$sig.rc" 2>/dev/null || echo "?")
  errs=$(errors_in "$EVID/resume-$sig.jsonl" | head -n 3)
  note "resume: rc=$rc errors=${errs:-none}"
  if [[ $rc == 0 && -z $errs ]]; then
    pass "SIG$sig: the session resumed without an error (no 400)"
  else
    fail "SIG$sig: resume failed: rc=$rc ${errs:-no error event} stderr: $(head -c 300 "$EVID/resume-$sig.err")"
  fi
done

finish
