#!/usr/bin/env bash
# req_refresh: requirements counters for the slot file, and a copy of the checklist in the run's
# log dir for the console's inspect drawer (SCHEMA 6.1).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u

K=1 RUN_ID=run-AAA
ST_RUN=$RUN_ID ST_STATE=running ST_STAGE=build ST_ISSUE_JSON=null ST_PR_JSON=null ST_TURN_JSON=null ST_CI_JSON=null
ST_STEER_LAST=null ST_INTR_JSON=null ST_REQ_TOTAL=-1 ST_REQ_DONE=0
run=$T/log/issue-5-20261016T055517Z-s1; mkdir -p "$run"
ST_LOGDIR=$run
SB_OUT=""
sb() { printf '%s' "$SB_OUT"; }   # stands in for "cat .git/agent-checklist.json" inside the sandbox

echo "valid checklist"
SB_OUT='[{"item":"a","done":true,"evidence":"x.rs:1"},{"item":"b","done":false},{"item":"c","done":true}]'
MSYS2_ARG_CONV_EXCL="*" req_refresh; rc=$?
assert_eq "returns 0" 0 "$rc"
assert_eq "total" 3 "$ST_REQ_TOTAL"
assert_eq "done" 2 "$ST_REQ_DONE"
assert_true "checklist.json written to the run dir" test -f "$run/checklist.json"
assert_json_eq "content is the checklist" "$SB_OUT" "$(cat "$run/checklist.json")"
assert_eq "mode 640" 640 "$(stat -c %a "$run/checklist.json")"
assert_eq "no temp file left behind" 0 "$(ls -A "$run" | grep -c '^\.')"
assert_eq "slot file reports 2/3" "3|2" "$(jq -r '[.requirements.total,.requirements.done]|join("|")' "$UI/slots/1.json")"

echo "later refresh replaces it"
SB_OUT='[{"item":"a","done":true},{"item":"b","done":true},{"item":"c","done":true}]'
req_refresh
assert_eq "all done" 3 "$(jq '[.[]|select(.done)]|length' "$run/checklist.json")"

echo "garbage and non-arrays"
good=$(cat "$run/checklist.json")
for bad in 'not json at all' '{"item":"a"}' '' '"str"'; do
  SB_OUT=$bad
  req_refresh; rc=$?
  assert_eq "returns 0 for: ${bad:-<empty>}" 0 "$rc"
  assert_json_eq "checklist.json untouched for: ${bad:-<empty>}" "$good" "$(cat "$run/checklist.json")"
done

echo "no checklist yet: nothing written"
rm -f "$run/checklist.json"
SB_OUT='garbage'
req_refresh
assert_false "no file for garbage" test -e "$run/checklist.json"
sb() { return 1; }
req_refresh; rc=$?
assert_eq "sandbox failure: returns 0" 0 "$rc"
assert_false "no file when the sandbox fails" test -e "$run/checklist.json"

echo "run dir missing: still returns 0"
run=$T/log/nope
SB_OUT='[{"item":"a","done":true}]'
sb() { printf '%s' "$SB_OUT"; }
req_refresh; rc=$?
assert_eq "returns 0" 0 "$rc"
assert_false "nothing created" test -e "$run"

finish
