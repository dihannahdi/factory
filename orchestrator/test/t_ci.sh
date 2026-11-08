#!/usr/bin/env bash
# ci_poll and Playwright: a job that fails only in Playwright passes until PLAYWRIGHT_GATE_AFTER (#190 here) is
# closed as completed, and fails after that. PLAYWRIGHT_GATE forces either way.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u

# A gh that answers ci_poll: one completed failed job; FAKE_STEPS = its failed step names (JSON).
cat > "$T/gh-fake" <<'G'
#!/usr/bin/env bash
case "$*" in
  *check-runs*) echo '[{"id":7,"name":"Build and test","status":"completed","conclusion":"failure"}]' ;;
  *actions/jobs/7*) echo "$FAKE_STEPS" ;;
esac
exit 0
G
chmod +x "$T/gh-fake"
export GH=$T/gh-fake
K=1 RUN_ID=run-AAA n=5 pr=7
mkdir -p "$UI"
done_list() { jq -nc --argjson d "$1" '{v: 1, ok: true, issues: [], prs: [], done: $d}' > "$UI/github.json"; }
poll() { ( ci_poll headsha; echo "$CI_STATE" ) 2>/dev/null | tail -n 1; }

echo "default (no PLAYWRIGHT_GATE_AFTER): Playwright is a gate"
unset PLAYWRIGHT_GATE
done_list '[]'
export FAKE_STEPS='["frontend e2e (Playwright)"]'
assert_eq "only Playwright failed: fail" fail "$(PLAYWRIGHT_GATE_AFTER= poll)"
assert_true "playwright_gate_on with nothing set" bash -c 'PLAYWRIGHT_GATE_AFTER=; source "$1" >/dev/null 2>&1; set +eu; PLAYWRIGHT_GATE_AFTER=; playwright_gate_on' _ "$ORCH/run.sh"
export PLAYWRIGHT_GATE_AFTER=190

echo "before #190 is done: Playwright-only failures pass"
unset PLAYWRIGHT_GATE
done_list '[]'
export FAKE_STEPS='["frontend e2e (Playwright)"]'
assert_eq "only Playwright failed: pass" pass "$(poll)"
export FAKE_STEPS='["cargo test","frontend e2e (Playwright)"]'
assert_eq "something else failed too: fail" fail "$(poll)"

echo "after #190 is closed as completed: Playwright is a gate"
done_list '[{"n":190,"title":"[OUT-35] e2e","tag":"OUT-35","milestone":"M2","closed_at":1792400000,"reason":"completed","deps":[]}]'
export FAKE_STEPS='["frontend e2e (Playwright)"]'
assert_eq "only Playwright failed: fail" fail "$(poll)"
assert_true "playwright_gate_on" playwright_gate_on

echo "#190 closed without being done keeps the gate off"
done_list '[{"n":190,"title":"x","tag":null,"milestone":null,"closed_at":1,"reason":"not_planned","deps":[]}]'
assert_eq "not_planned: pass" pass "$(poll)"

echo "PLAYWRIGHT_GATE forces either way"
done_list '[]'
assert_eq "PLAYWRIGHT_GATE=1: fail" fail "$(PLAYWRIGHT_GATE=1 poll)"
done_list '[{"n":190,"title":"x","tag":null,"milestone":null,"closed_at":1,"reason":"completed","deps":[]}]'
assert_eq "PLAYWRIGHT_GATE=0: pass" pass "$(PLAYWRIGHT_GATE=0 poll)"
rm -f "$UI/github.json"
assert_false "no github.json: gate off" playwright_gate_on

# ci_rerun: a gh that serves raw API JSON and applies the real -q filter with jq, so the filters in
# run.sh are exercised, not bypassed. Before the POST the commit's latest check runs are the failed
# job 7 (Actions run 55) and an external check without an Actions URL; after it, job 8 in progress.
cat > "$T/gh-rerun" <<'G'
#!/usr/bin/env bash
q=. path= post=0
while (( $# )); do
  case $1 in -q) q=$2; shift ;; -X) [[ $2 == POST ]] && post=1; shift ;; repos/*) path=$1 ;; esac
  shift
done
if (( post )); then
  [[ ${FAKE_REFUSE:-0} == 1 ]] && exit 1
  echo "$path" >> "$FAKE_D/posts"; touch "$FAKE_D/rerun"; exit 0
fi
case $path in
  *check-runs*)
    if [[ -f $FAKE_D/rerun ]]; then
      echo '{"check_runs":[{"id":8,"name":"Frontend build and e2e","status":"in_progress","conclusion":null,"details_url":"https://github.com/o/r/actions/runs/55/job/8"}]}'
    else
      echo "$FAKE_RUNS"
    fi | jq -r "$q" ;;
esac
exit 0
G
chmod +x "$T/gh-rerun"
export GH=$T/gh-rerun FAKE_D=$T/rr REPO=o/r
isleep() { :; }
log() { :; }
reset_rr() { rm -rf "$FAKE_D"; mkdir -p "$FAKE_D"; }
export FAKE_RUNS='{"check_runs":[
  {"id":7,"name":"Frontend build and e2e","status":"completed","conclusion":"failure","details_url":"https://github.com/o/r/actions/runs/55/job/7"},
  {"id":9,"name":"external","status":"completed","conclusion":"failure","details_url":"https://ci.example.invalid/9"},
  {"id":6,"name":"Rust build and test","status":"completed","conclusion":"success","details_url":"https://github.com/o/r/actions/runs/54/job/6"}]}'

echo "ci_rerun re-runs the failed Actions run once and waits for the new attempt"
reset_rr
assert_true "re-run requested: returns 0" ci_rerun headsha
assert_eq "POSTed rerun-failed-jobs for run 55 only" "repos/o/r/actions/runs/55/rerun-failed-jobs" "$(cat "$FAKE_D/posts" 2>/dev/null)"

echo "nothing to re-run, or not allowed: the caller goes on to the fix round"
reset_rr
rerun_off() { local CI_RERUN=0; ci_rerun "$@"; }
assert_false "CI_RERUN=0: returns 1" rerun_off headsha
assert_eq "CI_RERUN=0: no POST" "" "$(cat "$FAKE_D/posts" 2>/dev/null)"
reset_rr
export FAKE_RUNS='{"check_runs":[{"id":9,"name":"external","status":"completed","conclusion":"failure","details_url":"https://ci.example.invalid/9"}]}'
assert_false "only a non-Actions check failed: returns 1" ci_rerun headsha
reset_rr
export FAKE_RUNS='{"check_runs":[{"id":7,"name":"e2e","status":"completed","conclusion":"failure","details_url":"https://github.com/o/r/actions/runs/55/job/7"}]}'
refused() { local rc; export FAKE_REFUSE=1; ci_rerun "$@"; rc=$?; unset FAKE_REFUSE; return $rc; }
assert_false "GitHub refuses the re-run: returns 1" refused headsha

echo "shepherd re-runs at most once per head"
assert_eq "one guard per head in shepherd" 1 "$(grep -c 'if \[\[ \$rerun_head != "\$head" \]\]; then' "$ORCH/run.sh")"

finish
