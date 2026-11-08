#!/usr/bin/env bash
# The slot status writer reproduces the contract's fixtures exactly, and writes atomically.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/lib.sh"
set +e

echo "status_json vs contracts/fixtures/ui/slots"
export NOW=1792130120
K=1 ST_RUN=3f9a1c7e5b2d4e6f8a0b1c2d3e4f5a6b ST_STATE=running ST_STAGE=build ST_SUB="complete 2/4"
ST_ISSUE_JSON=$(issue_json 24 "[ELE-01] Gift cards: issue and redeem")
ST_MODEL=opencode/deepseek-v4.1-flash-free ST_SESSION=ses_ebcb87204ffeiYQE3LcxYNhHmu
ST_TURN_JSON='{"phase":"complete2","started":1792129783,"events":"/var/log/factory/issue-24-20261016T055517Z-s1/complete2-0.jsonl"}'
ST_STAGE_STARTED=1792128223 ST_ISSUE_STARTED=1792127717
ST_TOK_IN=161234 ST_TOK_OUT=21877 ST_TOK_REASON=10945 ST_TOK_CACHE=4011223
ST_REQ_TOTAL=9 ST_REQ_DONE=6 ST_EFF=2 ST_LOGDIR=/var/log/factory/issue-24-20261016T055517Z-s1
assert_json_eq "slot 1 (running, build, turn, requirements)" "$(cat "$FIX/ui/slots/1.json")" "$(MSYS2_ARG_CONV_EXCL="*" status_json)"

K=2 ST_RUN=7c2e9a4b1d3f5e7a9b0c2d4e6f8a1b3c ST_STATE=running ST_STAGE=ci ST_SUB=""
ST_ISSUE_JSON=$(issue_json 26 "[OUT-01] Category tree with drag to reorder (epic)")
ST_PR_JSON='{"n":140,"url":"https://github.com/acme/shop/pull/140","head":"9c1e7d2b5a4f"}'
ST_SESSION=ses_ebcb9a11c2ffeAbCdEfGh12345 ST_TURN_JSON=null ST_STAGE_STARTED=1792129713 ST_ISSUE_STARTED=1792124823
ST_TOK_IN=240511 ST_TOK_OUT=30112 ST_TOK_REASON=18800 ST_TOK_CACHE=6120441 ST_REQ_TOTAL=7 ST_REQ_DONE=7
ST_CI_JSON=$(jq -c '.ci' "$FIX/ui/slots/2.json")
ST_STEER_LAST=$(jq -c '.steer.last' "$FIX/ui/slots/2.json")
ST_INTR_JSON=$(jq -c '.interrupt' "$FIX/ui/slots/2.json")
ST_LOGDIR=/var/log/factory/issue-26-20261016T043000Z-s2
NOW=1792130111
assert_json_eq "slot 2 (ci, pr, ci checks, steer.last, interrupt)" "$(cat "$FIX/ui/slots/2.json")" "$(MSYS2_ARG_CONV_EXCL="*" status_json)"

K=3 ST_RUN="" ST_STATE=parked ST_STAGE="" ST_SUB="" ST_ISSUE_JSON=null ST_PR_JSON=null ST_MODEL="" ST_SESSION="" ST_TURN_JSON=null
ST_STAGE_STARTED=0 ST_ISSUE_STARTED=0 ST_TOK_IN=0 ST_TOK_OUT=0 ST_TOK_REASON=0 ST_TOK_CACHE=0 ST_REQ_TOTAL=-1 ST_REQ_DONE=0
ST_CI_JSON=null ST_STEER_LAST=null ST_INTR_JSON=null ST_LOGDIR="" ST_EFF=2
NOW=1792130093
assert_json_eq "slot 3 (parked, everything null)" "$(cat "$FIX/ui/slots/3.json")" "$(MSYS2_ARG_CONV_EXCL="*" status_json)"

echo "derived fields"
K=1 ST_STATE=running DRAIN=1 ST_RUN=abc
assert_eq "running + agents lowered = draining" draining "$(MSYS2_ARG_CONV_EXCL="*" status_json | jq -r .state)"
DRAIN=0
ST_SUB="0123456789012345678901234567890123456789-overflow"
assert_eq "sub is cut to 40 chars" 40 "$(MSYS2_ARG_CONV_EXCL="*" status_json | jq -r '.sub | length')"
ST_SUB=""
ST_NOTE=$(printf 'x%.0s' $(seq 1 300))
assert_eq "note is cut to 200 chars" 200 "$(MSYS2_ARG_CONV_EXCL="*" status_json | jq -r '.note | length')"
ST_NOTE=""
ST_STEER_PENDING='{"id":"i1","message":"pakai ADR-0012","received_at":5}'
assert_eq "pending steer is reported" i1 "$(MSYS2_ARG_CONV_EXCL="*" status_json | jq -r .steer.pending.id)"
ST_STEER_PENDING=null

echo "issue_json"
assert_json_eq "tag and family from the title" '{"n":7,"title":"[ENG-04] weather","tag":"ENG-04","family":"ENG","url":"https://github.com/acme/shop/issues/7"}' "$(issue_json 7 '[ENG-04] weather')"
assert_json_eq "no tag: nulls" '{"n":8,"title":"plain","tag":null,"family":null,"url":"https://github.com/acme/shop/issues/8"}' "$(issue_json 8 'plain')"

echo "st_flush writes atomically"
K=2 ST_RUN=r ST_STATE=running ST_STAGE=plan ST_ISSUE_JSON=null ST_PR_JSON=null ST_TURN_JSON=null ST_CI_JSON=null ST_STEER_LAST=null ST_INTR_JSON=null ST_LOGDIR="" ST_REQ_TOTAL=-1
MSYS2_ARG_CONV_EXCL="*" st_flush
assert_true "slots/2.json exists and parses" jq -e '.slot == 2 and .stage == "plan"' "$UI/slots/2.json"
assert_eq "no temp file left behind" 1 "$(ls -A "$UI/slots" | wc -l | tr -d ' ')"
MSYS2_ARG_CONV_EXCL="*" st stage=build sub="complete 1/4" note=hi
assert_eq "st sets fields and rewrites" "build|complete 1/4|hi" "$(jq -r '[.stage,.sub,.note]|join("|")' "$UI/slots/2.json")"
ST_DISABLED=1
st stage=review
assert_eq "ST_DISABLED (DRY_PICK) writes nothing" build "$(jq -r .stage "$UI/slots/2.json")"
finish
