#!/usr/bin/env bash
# merge_pr releases the merge lock right after the merge (the deploy wait happens outside it), and
# a deploy run cancelled by a newer push counts as deployed when a descendant's run succeeded.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u

# A gh that answers merge_pr and deploy. FAKE_RUNS = the lines `run list` prints.
cat > "$T/gh-fake" <<'G'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$*" in
  "pr view"*headRefOid*) echo abc123 ;;
  "pr view"*"--json body"*) echo "Closes #5" ;;
  "pr view"*mergeCommit*) echo mergedsha ;;
  "pr view"*files*) echo crates/shop-api/src/main.rs ;;
  "pr merge"*) ;;
  "api repos/"*check-runs*) echo '[{"id":1,"name":"Build and test","status":"completed","conclusion":"success"}]' ;;
  "run list"*) cat "$FAKE_RUNS" ;;
  "run view 11"*) echo "completed cancelled" ;;
  "run view"*) echo "completed success" ;;
esac
exit 0
G
chmod +x "$T/gh-fake"
export GH=$T/gh-fake FAKE_GH_LOG=$T/gh.log FAKE_RUNS=$T/runs.txt
K=1 RUN_ID=run-AAA n=5 pr=7 base=deadbeef
mkdir -p "$STATE/claims" "$STATE/locks" "$STATE/sessions" "$T/log/i"; run=$T/log/i
ST_RUN=$RUN_ID
export CTL UI HEALTH_URL=http://health.invalid
control_load

echo "merge lock is released before the deploy wait"
: > "$FAKE_GH_LOG"
deploy() { echo "held=[${HELD_LOCKS# }] sha=$1 pr=$2 noint=$NOINT" > "$T/deploy.seen"; }
merge_pr abc123
assert_eq "merged" merged "$MERGE_RESULT"
assert_eq "deploy ran for the merge commit, without the merge lock, still uninterruptible" "held=[] sha=mergedsha pr=7 noint=1" "$(cat "$T/deploy.seen")"
assert_eq "NOINT cleared after the deploy" 0 "$NOINT"
assert_true "the merge was recorded before the deploy" bash -c "jq -e -s 'any(.[]; .kind == \"outcome\" and .outcome == \"merged\")' '$UI/stats.jsonl' >/dev/null"
assert_true "a second lane can take the merge lock during the deploy wait" bash -c "source '$ORCH/lib.sh'; STATE='$STATE'; lock_take merge 0"

echo "deploy: a run cancelled by a newer push"
unset -f deploy
source "$ORCH/run.sh"
isleep() { :; }
git() { :; }
export -f git 2>/dev/null
# main: A (ours) <- B ; the stub git says merge-base --is-ancestor succeeds for every pair
printf '%s\n' "11 aaaa completed cancelled" "12 bbbb completed success" > "$T/runs.txt"
# deploy() finds the run for $1 by --json databaseId,headSha -q: have the fake print just the id
cat > "$T/gh-fake2" <<'G'
#!/usr/bin/env bash
case "$*" in
  "run list"*databaseId,headSha,status,conclusion*) cat "$FAKE_RUNS" ;;
  "run list"*) echo 11 ;;
  "pr view"*files*) echo crates/x.rs ;;
  "run view 11"*) echo "completed cancelled" ;;
  "run view"*) echo "completed success" ;;
esac
exit 0
G
chmod +x "$T/gh-fake2"; GH=$T/gh-fake2
stage() { :; }
( deploy aaaa 7 ) >"$T/d1.out" 2>&1; rc=$?
assert_eq "cancelled + a descendant deployed: no halt" 0 "$rc"
assert_false "no halt.json" test -e "$UI/halt.json"
assert_true "logged as superseded" grep -q "superseded" "$T/d1.out"
printf '%s\n' "11 aaaa completed cancelled" "12 bbbb completed failure" > "$T/runs.txt"
( deploy aaaa 7 ) >"$T/d2.out" 2>&1
assert_true "a descendant's real failure still halts" test -s "$UI/halt.json"

echo "wait_run: the deadline counts time without progress, not the whole run"
# A gh that prints the next line of $FAKE_SEQ per `run view`, then repeats the last one.
cat > "$T/gh-seq" <<'G'
#!/usr/bin/env bash
i=$(( $(cat "$FAKE_SEQ.i" 2>/dev/null || echo 0) + 1 )); echo "$i" > "$FAKE_SEQ.i"
sed -n "${i}p" "$FAKE_SEQ" | grep . || tail -n1 "$FAKE_SEQ"
G
chmod +x "$T/gh-seq"; GH=$T/gh-seq FAKE_SEQ=$T/seq.txt
export FAKE_SEQ
isleep() { NOW=$((NOW + $1)); }
DEPLOY_TIMEOUT=100
# A real deploy run's shape: its own CI, then queued behind a PR's CI, then the deploy job. 210 s
# in all, never more than 90 s without a job starting or finishing.
printf '%s\n' "in_progress in_progress " "in_progress in_progress " "in_progress in_progress " \
  "in_progress completed,queued " "in_progress completed,queued " "in_progress completed,queued " \
  "in_progress completed,in_progress " "completed completed,completed success" > "$T/seq.txt"
rm -f "$T/seq.txt.i"; NOW=1000
wait_run 39896717432
assert_eq "a run that keeps moving past DEPLOY_TIMEOUT is waited out" success "$WAIT_RESULT"
printf '%s\n' "in_progress in_progress " "in_progress completed,queued " > "$T/seq.txt"
rm -f "$T/seq.txt.i"; NOW=1000
wait_run 1
assert_eq "a job queued for longer than DEPLOY_TIMEOUT times out" timeout "$WAIT_RESULT"
assert_eq "...DEPLOY_TIMEOUT after the last progress, not after the start" 1150 "$NOW"

echo "deploy without HEALTH_URL: nothing to watch, no halt"
rm -f "$UI/halt.json"
cat > "$T/gh-none" <<'G'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
exit 0
G
chmod +x "$T/gh-none"; GH=$T/gh-none; : > "$FAKE_GH_LOG"
stage() { echo "stage $*" >> "$T/stages"; }; : > "$T/stages"
( HEALTH_URL="" deploy sha1 7 ) >"$T/d3.out" 2>&1; rc=$?
assert_eq "returns 0" 0 "$rc"
assert_false "no halt.json" test -e "$UI/halt.json"
assert_eq "not a single gh call (no deploy run is looked for)" 0 "$(wc -l < "$FAKE_GH_LOG")"
assert_eq "the lane goes straight to live" "stage live" "$(cat "$T/stages")"
assert_true "and says why" grep -q 'no HEALTH_URL' "$T/d3.out"

set +e   # run.sh was sourced again above, which turned -e back on
echo "MERGE_MODE"
assert_eq "default is pr" pr "$(env -u MERGE_MODE bash -c 'source "$1"; echo "$MERGE_MODE"' _ "$ORCH/run.sh")"
assert_eq "an empty value means the default" pr "$(MERGE_MODE= bash -c 'source "$1"; echo "$MERGE_MODE"' _ "$ORCH/run.sh")"
out=$(MERGE_MODE=yes bash "$ORCH/run.sh" --slot 1 2>&1); rc=$?
assert_eq "an unknown MERGE_MODE is refused before anything runs" 2 "$rc"
assert_true "...saying what is valid" grep -q 'MERGE_MODE must be pr or auto' <<<"$out"
assert_true "shepherd hands the PR to ready_pr unless MERGE_MODE=auto" grep -q 'if \[\[ \$MERGE_MODE != auto \]\]; then ready_pr "\$head"; return 0; fi' "$ORCH/run.sh"
# ready_pr: label, comment, outcome; never a merge.
GH=$T/gh-none; : > "$FAKE_GH_LOG"; pr=7 n=5 impl_model=m
stage_end() { :; }
ready_pr abc123def4567890 >/dev/null 2>&1; rc=$?
assert_eq "ready_pr returns 0" 0 "$rc"
assert_true "labels the PR agent-ready" grep -q 'pr edit 7 -R .* --add-label agent-ready' "$FAKE_GH_LOG"
assert_true "comments on it, naming the head" grep -q 'pr comment 7 .*abc123def456' "$FAKE_GH_LOG"
assert_false "never merges" grep -q 'pr merge' "$FAKE_GH_LOG"
assert_true "records outcome ready" bash -c "jq -e -s 'any(.[]; .kind == \"outcome\" and .outcome == \"ready\")' '$UI/stats.jsonl' >/dev/null"
# open_agent_prs leaves agent-ready PRs alone.
cat > "$T/gh-prs" <<'G'
#!/usr/bin/env bash
echo '[{"number":7,"headRefName":"agent/issue-5","createdAt":"2026-01-01T00:00:00Z","body":"Closes #5","isCrossRepository":false,"labels":[{"name":"agent"},{"name":"agent-ready"}]},
       {"number":8,"headRefName":"agent/issue-6","createdAt":"2026-01-02T00:00:00Z","body":"Closes #6","isCrossRepository":false,"labels":[{"name":"agent"}]}]'
G
chmod +x "$T/gh-prs"; GH=$T/gh-prs
assert_eq "only the PR not labelled agent-ready is listed" "8 6" "$(open_agent_prs)"
finish
