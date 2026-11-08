#!/usr/bin/env bash
# Adopting a human PR (label agent-adopt): the classifier, pick order, the retry cap, the adoption
# run with fakes (checkout from the PR head, merge main, comment instead of body, label `agent`
# only after export, fast-forward-only push and the moved-head case, incomplete checklist), the
# shepherd's merge gate, and that ordinary issues are untouched.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"; set +e; set +u
set +e
set +u
PROMPTS=$ORCH/prompts

# ------------------------------------------------------------------ classifier
mkissue() {  # n title milestone labels-csv [assignee]
  jq -nc --argjson n "$1" --arg t "$2" --arg m "$3" --arg l "$4" --arg a "${5:-}" '
    {number: $n, title: $t, body: "", labels: ($l | split(",") | map(select(. != "") | {name: .})),
     milestone: (if $m == "" then null else {title: $m} end), assignees: (if $a == "" then [] else [{login: $a}] end)}'
}
mkpr() {  # n head labels-csv body cross(true|false) [title]
  jq -nc --argjson n "$1" --arg h "$2" --arg l "$3" --arg b "$4" --argjson c "$5" --arg t "${6:-PR $1}" '
    {number: $n, title: $t, body: $b, labels: ($l | split(",") | map(select(. != "") | {name: .})), headRefName: ("feat/x" + ($n | tostring)),
     headRefOid: $h, isCrossRepository: $c, createdAt: "2026-10-01T00:00:00Z", mergeable: "MERGEABLE", statusCheckRollup: [], url: "u"}'
}
{
  mkissue 108 "[OUT-29] sso" M2 "P2"
  mkissue 15  "[ENG-12] inverter" M1 "P0" someone
  mkissue 12  "[ENG-09] irradiance" M1 "P0"
  mkissue 125 "[LAY-25] pecah studio" "" "P0"
  mkissue 40  "[ENG-40] biasa" M1 "P0"
  mkissue 41  "[ENG-41] fork" M1 "P0"
  mkissue 42  "[ENG-42] no reference" M1 "P0"
  mkissue 43  "[ENG-43] dua referensi" M1 "P0"
  mkissue 44  "[ENG-44] berdampingan" M1 "P0"
  mkissue 45  "[ENG-45] bergantung" M1 "P0"
  mkissue 46  "[ENG-46] failed" M1 "P0,agent-failed"
  mkissue 47  "[ENG-47] skip" M1 "P0"
  mkissue 48  "[ENG-48] dua PR" M1 "P0"
  mkissue 49  "[ENG-49] dibatasi" M1 "P0"
  mkissue 50  "[ENG-50] PR agent" M1 "P0"
} | jq -sc . > "$T/issues.json"
{
  mkpr 129 aaa "agent-adopt" "Landing copy.

closes #108" false
  mkpr 131 bbb "agent-adopt" "Fixes #15" false
  mkpr 133 ccc "agent-adopt,enhancement" "RESOLVES #12 (ENG-09)" false
  mkpr 134 ddd "agent-adopt" "Closes #125" false
  mkpr 141 eee "agent-adopt" "Closes #41" true
  mkpr 142 fff "agent-adopt" "names nothing" false
  mkpr 143 ggg "agent-adopt" "Closes #43 and Closes #44" false
  mkpr 145 hhh "agent-adopt" "Closes #45" false
  mkpr 146 iii "agent-adopt" "Closes #46" false
  mkpr 147 jjj "agent-adopt" "Closes #47" false
  mkpr 148 kkk "agent-adopt" "Closes #48" false
  mkpr 149 lll "agent-adopt" "Closes #48" false
  mkpr 150 mmm "agent-adopt" "Closes #49" false
  mkpr 151 nnn "agent-adopt" "Closes #9999" false
  mkpr 152 ooo "agent-adopt,agent" "Closes #50" false "[ENG-50] already an agent PR"
  mkpr 160 ppp "" "Closes #40, not an adoption" false
} | jq -sc . > "$T/prs.json"
export NOW=1792130000
cat > "$CTL/control.json" <<'J'
{"v":1,"agents":3,"models":["opencode/deepseek-v4.1-flash-free"],"model_mode":"ordered","paused":false,"queue":[],"skip":[47],"resume_ack":null}
J
mkdir -p "$STATE/claims" "$STATE/blocked" "$STATE/adopt" "$STATE/sessions"
echo '[8]' > "$STATE/blocked/45"                      # #45 waits for the open issue #8
# the issue list needs #8 open for the dependency to count
jq -c '. + [{number: 8, title: "[ENG-08] dep", body: "", labels: [], milestone: {title: "M1"}, assignees: []}]' "$T/issues.json" > "$T/issues2.json" && mv "$T/issues2.json" "$T/issues.json"
# #49: two runs already, on head "lll"... PR 150 has head mmm
echo '{"issue":49,"last_head":"mmm","human_head":"mmm","runs":2,"complete":false}' > "$STATE/adopt/150.json"
control_load
export FAKE_ACTIVE=active FAKE_INV=inv-x

d=$T/work; mkdir -p "$d"
cp "$T/issues.json" "$d/issues.json"; cp "$T/prs.json" "$d/prs.json"
gather_local "$d"
out=$(classify_run "$d")
cls() { jq -r --argjson n "$1" '.[] | select(.n == $n) | .class' <<<"$out"; }
fld() { jq -r --argjson n "$1" ".[] | select(.n == \$n) | $2" <<<"$out"; }

echo "classifier: adopted issues are pickable, not taken"
assert_eq "#108 (closes, lower case, one ref): eligible" eligible "$(cls 108)"
assert_eq "#108 reason names the PR" "PR #129 adopted" "$(fld 108 .reason)"
assert_eq "#108 adopt_pr" 129 "$(fld 108 .adopt_pr)"
assert_eq "#108 not taken by its own PR" "[]" "$(fld 108 '.taken_by | tostring')"
assert_eq "#15 (Fixes, has an assignee): eligible, the label is the explicit request" eligible "$(cls 15)"
assert_eq "#12 (RESOLVES, other labels around): eligible" eligible "$(cls 12)"
assert_eq "#125 (no milestone): eligible, adopt_pr 134" "eligible 134" "$(cls 125) $(fld 125 .adopt_pr)"
assert_eq "#40 (PR without the label names it): taken, as before" taken "$(cls 40)"
assert_eq "#40 has no adopt_pr key" null "$(fld 40 '.adopt_pr // null')"

echo "classifier: ignored labels"
assert_eq "#41 fork PR: ordinary issue, not adopted" null "$(fld 41 '.adopt_pr // null')"
assert_eq "#42 no reference: not adopted" null "$(fld 42 '.adopt_pr // null')"
assert_eq "#43 and #44 two references in one PR: neither adopted" "null null" "$(fld 43 '.adopt_pr // null') $(fld 44 '.adopt_pr // null')"
assert_eq "#43 still taken by the PR that names it (old rule)" taken "$(cls 43)"
rep=$(adopt_report "$d")
reason() { jq -r --argjson p "$1" '.ignored[] | select(.pr == $p) | .reason' <<<"$rep"; }
assert_true "fork reason" bash -c "grep -q fork <<<'$(reason 141)'"
assert_true "no-reference reason" bash -c "grep -q 'no Closes/Fixes/Resolves' <<<'$(reason 142)'"
assert_true "two-reference reason lists both" bash -c "grep -q '#43, #44' <<<'$(reason 143)'"
assert_true "closed/unknown issue reason" bash -c "grep -q 'is not open' <<<'$(reason 151)'"
assert_eq "two PRs for one issue: the lower number wins" "148" "$(jq -r '.adopted[] | select(.issue == 48) | .pr' <<<"$rep")"
assert_true "the other one is ignored with the winner named" bash -c "grep -q 'is already adopted by PR #148' <<<'$(reason 149)'"
assert_eq "#48 adopted by 148" "148" "$(fld 48 .adopt_pr)"
assert_eq "a PR that already carries agent is not adopted (ordinary taker)" "taken null" "$(cls 50) $(fld 50 '.adopt_pr // null')"
assert_eq "the unlabelled PR is not in the report at all" "" "$(jq -r '[.adopted[].pr, .ignored[].pr] | map(select(. == 160)) | .[]' <<<"$rep")"

echo "classifier: dependencies, failed, skip, claims, retry cap"
assert_eq "#45 open dependency: blocked even though adopted" blocked "$(cls 45)"
assert_eq "#45 reason" "waiting for #8" "$(fld 45 .reason)"
assert_eq "#46 agent-failed: failed" failed "$(cls 46)"
assert_eq "#47 control.skip: skipped" skipped "$(cls 47)"
assert_eq "#49 two runs on the same head: ineligible" ineligible "$(cls 49)"
assert_true "#49 reason says why" bash -c "grep -q '2 attempts' <<<'$(fld 49 .reason)'"
assert_eq "#49 still carries adopt_pr" 150 "$(fld 49 .adopt_pr)"
jq -c '(.[] | select(.number == 150) | .headRefOid) = "mmm2"' "$d/prs.json" > "$d/prs2.json"; mv "$d/prs2.json" "$d/prs.json"
out=$(classify_run "$d")
assert_eq "#49 after a human push (new head): eligible again" eligible "$(cls 49)"
jq -c '(.[] | select(.number == 150) | .headRefOid) = "mmm"' "$d/prs.json" > "$d/prs2.json"; mv "$d/prs2.json" "$d/prs.json"
echo '{"slot":2,"run_id":"inv-x","at":1,"state":"active","pid":1}' > "$STATE/claims/108"
gather_local "$d"; out=$(classify_run "$d")
assert_eq "#108 claimed by a lane: running, so no second lane takes it" running "$(cls 108)"
assert_eq "#108 still shows adopt_pr while running" 129 "$(fld 108 .adopt_pr)"
rm -f "$STATE/claims/108"
gather_local "$d"; out=$(classify_run "$d")

echo "pick order: adopted first, then the existing order"
adopted_order=$(jq -c '[.[] | select(.order != null and .adopt_pr != null)] | sort_by(.order) | map(.n)' <<<"$out")
assert_json_eq "adopted issues in milestone/priority/number order, no milestone last" '[12,15,48,108,125]' "$adopted_order"
assert_eq "every fresh eligible issue comes after every adopted one" true "$(jq '([.[] | select(.order != null and .adopt_pr != null) | .order] | max) as $a | all(.[] | select(.order != null and .adopt_pr == null); .order > $a)' <<<"$out")"
assert_eq "and there are fresh ones to compare with" true "$(jq '[.[] | select(.order != null and .adopt_pr == null)] | length > 0' <<<"$out")"

echo "pick_issue prints the adopted PR; normal issues print two fields"
mkdir -p "$T/gh"; cp "$T/issues.json" "$T/gh/issues.json"; cp "$T/prs.json" "$T/gh/prs.json"; export FAKE_GH_DIR=$T/gh
assert_eq "pick_issue: issue, class, PR" "12 eligible 133" "$(pick_issue)"
assert_eq "adopt_lookup for an adopted issue" 129 "$(adopt_lookup 108)"
assert_eq "adopt_lookup for an ordinary issue is empty" "" "$(adopt_lookup 42)"
jq -c 'map(select(.number | IN(129, 131, 133, 134, 148, 149) | not))' "$T/gh/prs.json" > "$T/gh/p2.json"; mv "$T/gh/p2.json" "$T/gh/prs.json"
jq -c 'map(select(.number | IN(15, 12, 125, 108, 48) | not))' "$T/gh/issues.json" > "$T/gh/i2.json"; mv "$T/gh/i2.json" "$T/gh/issues.json"
assert_eq "without adoptions an ordinary issue prints exactly two fields (unchanged)" "42 eligible" "$(pick_issue)"

echo "github.json (sync) carries adopt_pr, adopt flags and adopt_ignored"
cp "$T/issues.json" "$T/gh/issues.json"; cp "$T/prs.json" "$T/gh/prs.json"
export GH_TOKEN_FILE=$T/token; echo tok > "$GH_TOKEN_FILE"
export OPENCODE_CONF=$T/opencode.json OPENCODE_TEMPLATE=$ORCH/opencode.json FAKE_CURL_DIR=$T/curl SANDBOX=$T/none
mkdir -p "$T/curl"
echo '{"data":[{"id":"a-free"}]}' > "$T/curl/zen.json"
echo '{"opencode":{"models":{"a-free":{"name":"A","cost":{"input":0,"output":0},"limit":{"context":1,"output":2}}}}}' > "$T/curl/modelsdev.json"
echo '{"slot":3,"run_id":"x","at":1,"state":"done","until":1}' > "$STATE/claims/none"
bash "$ORCH/sync.sh" >/dev/null 2>&1
assert_eq "github.json ok" true "$(jq -r .ok "$UI/github.json")"
assert_eq "issue #108: adopt_pr 129 and eligible" "129 eligible" "$(jq -r '.issues[] | select(.n == 108) | "\(.adopt_pr) \(.class)"' "$UI/github.json")"
assert_eq "an ordinary issue has no adopt_pr key" false "$(jq '.issues[] | select(.n == 42) | has("adopt_pr")' "$UI/github.json")"
assert_eq "adopt_ignored lists the fork PR with a reason" "true" "$(jq '[.adopt_ignored[] | select(.pr == 141 and (.reason | test("fork")))] | length == 1' "$UI/github.json")"
assert_eq "prs[] carry adopt:true for labelled PRs" "true false" "$(jq -r '[(.prs[] | select(.n == 129) | .adopt), (.prs[] | select(.n == 160) | .adopt)] | map(tostring) | join(" ")' "$UI/github.json")"
assert_eq "the record of a PR that is still open is kept" "yes" "$( [[ -e $STATE/adopt/150.json ]] && echo yes || echo no )"
echo '{"issue":1,"last_head":"z","runs":1,"complete":false}' > "$STATE/adopt/999.json"
bash "$ORCH/sync.sh" >/dev/null 2>&1
assert_false "adopt_gc removes the record of closed PR #999" test -e "$STATE/adopt/999.json"
rm -f "$STATE/adopt/150.json"

# ------------------------------------------------------------------ retry cap state
echo "adoption state: runs per head"
rm -f "$STATE/adopt"/*.json
adopt_begin 7 5 h1
assert_eq "first run on h1: 1" 1 "$(adopt_get 7 | jq .runs)"
adopt_update 7 h2 false                   # our own push moved the head to h2
adopt_begin 7 5 h2
assert_eq "next run on our own head h2 keeps counting" 2 "$(adopt_get 7 | jq .runs)"
assert_eq "human_head stays the head we first saw" h1 "$(adopt_get 7 | jq -r .human_head)"
adopt_update 7 h2 false
adopt_begin 7 5 h3
assert_eq "a head we did not produce (human push) resets the count" "1 h3" "$(adopt_get 7 | jq -r '"\(.runs) \(.human_head)"')"
assert_false "not complete" adopt_complete 7
adopt_update 7 h3 true
assert_true "complete after adopt_update true" adopt_complete 7
adopt_forget 7
assert_false "forgotten" adopt_known 7

# ------------------------------------------------------------------ the adoption run, with fakes
cat > "$T/gh-fake" <<'G'
#!/usr/bin/env bash
echo "GH $*" >> "$FAKE_LOG"
case "$*" in
  "pr view"*"--json state,title"*) cat "$FAKE_PRVIEW" ;;
  "pr view"*"--json headRefName"*) echo feat/x ;;
  "pr comment"*)
    prev=""; for a in "$@"; do if [[ $prev == --body-file ]]; then cp "$a" "$FAKE_COMMENT"; fi; prev=$a; done ;;
  "pr create"*) echo "https://github.com/acme/shop/pull/99" ;;
  "issue list"*"number,body"*) def='[{"number":3,"body":""}]'; printf '%s\n' "${FAKE_ISSUES:-$def}" ;;
  "issue list"*) echo "[3]" ;;
  "issue comment"*) cat > "$FAKE_ICOMMENT" ;;
esac
exit 0
G
chmod +x "$T/gh-fake"
export GH=$T/gh-fake FAKE_LOG=$T/ops.log FAKE_COMMENT=$T/comment.md FAKE_PRVIEW=$T/prview.json FAKE_ICOMMENT=$T/icomment.md
K=1 RUN_ID=run-AAA; ST_RUN=$RUN_ID; base=basesha
PG_ENABLE=0
run=""
mkdir -p "$STATE/sessions" "$STATE/blocked"
jq -nc '{state: "OPEN", title: "Landing copy", body: "Closes #108", headRefName: "feat/x", headRefOid: "headA", isCrossRepository: false,
         labels: [{name: "agent-adopt"}]}' > "$FAKE_PRVIEW"
jq -nc --arg t $'ringkas\n```json\n{"decision":"go","reason":"r","requirements":["a","b"],"slice":"SLICE","files":[],"tests":"t"}\n```' \
  '{type: "text", part: {text: $t}}' > "$T/plan-go.jsonl"
jq -nc --arg t $'tunggu\n```json\n{"decision":"blocked","reason":"butuh 3","depends_on":[3]}\n```' \
  '{type: "text", part: {text: $t}}' > "$T/plan-blocked.jsonl"
jq -nc --arg t $'wait\n```json\n{"decision":"blocked","reason":"needs 3 and 5","depends_on":[3,5]}\n```' \
  '{type: "text", part: {text: $t}}' > "$T/plan-blocked35.jsonl"
echo '[{"item":"a","done":true,"evidence":"x.rs:1"},{"item":"b","done":true,"evidence":"y.rs:2"}]' > "$T/checklist-full.json"
echo '[{"item":"a","done":true,"evidence":"x.rs:1"},{"item":"b kurang","done":false}]' > "$T/checklist-part.json"

# stubs
_adopt_fetch() { echo "$FAKE_FETCH_HEAD"; }
load_issue() { echo '{"state":"OPEN"}' > "$run/issue.json"; title="Landing copy"; issue_text="ISSUE TEXT #$1"; issue_begin "$1" "$title"; }
checkout() { echo "CHECKOUT $*" >> "$FAKE_LOG"; CHECKOUT_SHA=$2; }
export_branch() { echo "EXPORT $* adopted=$ADOPTED from=$CHECKOUT_SHA" >> "$FAKE_LOG"; EXPORT_MOVED=${FAKE_MOVED:-0}; }
fix_loop() { echo "FIXLOOP $*" >> "$FAKE_LOG"; [[ -z ${FAKE_VERIFY_FAIL:-} ]]; }
complete_loop() { return 0; }
review_branch() { review_text="REVIEW TEXT"; return 0; }
sb() {
  case "$*" in
    *"merge-base --is-ancestor"*) return "${FAKE_BEHIND:-0}" ;;
    *"merge --abort"*) return 0 ;;
    *"merge --no-edit main"*) echo "SB-MERGE" >> "$FAKE_LOG"; return "${FAKE_MERGE_RC:-0}" ;;
    *"rev-parse HEAD"*) echo "$FAKE_NEWHEAD" ;;
    *"rev-list --count"*) cat "$T/commits" 2>/dev/null || echo 3 ;;
    *"status --porcelain"*) printf '%s' "${FAKE_DIRTY:-}" ;;
    *"cat .git/agent-checklist.json"*) cat "$FAKE_CHECKLIST" ;;
    *"test -e .git/agent-blocked.md"*) return 1 ;;
    *"agent-pr-body.md"*) echo "RINGKASAN AGEN" ;;
    *"--stat"*) echo " a.rs | 2 +-" ;;
    *"bash -c"*) echo "diff --git a/a.rs b/a.rs" ;;
  esac
  return 0
}
agent() {
  echo "AGENT $1" >> "$FAKE_LOG"
  printf '%s' "$3" > "$T/msg-$1"
  printf '%s|%s\n' "$1" "${sid:-}" >> "$T/sidlog"
  case $1 in
    plan) sid=ses1; last_model=m1; last_out=${FAKE_PLAN:-$T/plan-go.jsonl} ;;
    replan) last_model=m1; last_out=${FAKE_REPLAN:-$T/plan-go.jsonl} ;;
    complete-commit) last_model=m1; if [[ -n ${FAKE_RESUME_COMMITS:-} ]]; then echo "$FAKE_RESUME_COMMITS" > "$T/commits"; fi ;;
    *) last_model=m1 ;;
  esac
  return 0
}
steer_point() { return 0; }

reset_run() {  # reset_run <issue-arg-free>: fresh log dir, files and globals for one scenario
  : > "$FAKE_LOG"; rm -f "$FAKE_COMMENT" "$FAKE_ICOMMENT" "$T/sidlog" "$T"/msg-* "$UI/stats.jsonl" "$STATE/blocked"/*
  rm -f "$STATE/adopt"/*.json
  run="" pr="" adopt_pr="" ADOPTED=0 EXPORT_MOVED=0 plan="" RUN_COST=0
  export FAKE_FETCH_HEAD=headA FAKE_NEWHEAD=headB FAKE_BEHIND=0 FAKE_MERGE_RC=0 FAKE_CHECKLIST=$T/checklist-full.json FAKE_PLAN=$T/plan-go.jsonl
  unset FAKE_MOVED FAKE_VERIFY_FAIL FAKE_ISSUES FAKE_REPLAN FAKE_DIRTY FAKE_RESUME_COMMITS
  rm -f "$T/commits"
  ST_STATE=running ST_ISSUE_JSON=null ST_PR_JSON=null ST_TURN_JSON=null ST_CI_JSON=null ST_NOTE=""
}
outcomes() { jq -r -s '[.[] | select(.kind == "outcome") | .outcome] | join(",")' "$UI/stats.jsonl" 2>/dev/null; }
gh_has() { grep -qE "$1" "$FAKE_LOG"; }
line_of() { grep -nE "$1" "$FAKE_LOG" | head -1 | cut -d: -f1; }

echo "adoption run: complete checklist"
reset_run
( adopt 108 129 ) >"$T/a1.out" 2>&1; rc=$?
assert_eq "returns 0 (the lane goes on to the shepherd)" 0 "$rc"
assert_eq "checkout of the PR head (fetched from refs/pull/129/head), on its own branch name" "CHECKOUT feat/x headA" "$(grep '^CHECKOUT' "$FAKE_LOG")"
assert_false "no merge of main when the head already contains it" gh_has '^SB-MERGE'
assert_false "no conflict turn" gh_has 'AGENT merge0'
assert_true "plan prompt: issue text" grep -q 'ISSUE TEXT #108' "$T/msg-plan"
assert_true "plan prompt: PR diff stat and diff" bash -c "grep -q 'a.rs | 2' '$T/msg-plan' && grep -q 'diff --git a/a.rs' '$T/msg-plan'"
assert_true "plan prompt: says a human already started" grep -q 'A human already started' "$T/msg-plan"
assert_true "plan prompt: triage contract still there" grep -q 'Step 1 of 2: PLAN' "$T/msg-plan"
assert_true "build prompt: audit first, keep the human design" bash -c "grep -q 'AUDIT first' '$T/msg-build' && grep -q 'Keep the author.s design' '$T/msg-build'"
assert_true "build prompt: common output contract (checklist, pr-body, commit)" bash -c "grep -q 'agent-pr-body.md' '$T/msg-build' && grep -q 'agent-checklist.json' '$T/msg-build'"
assert_true "export called for the adopted PR, from the head we checked out" gh_has 'EXPORT feat/x adopted=1 from=headA'
assert_false "no new PR" gh_has '^GH pr create'
assert_false "the human's PR body is not replaced" gh_has '^GH pr edit .*--body'
assert_true "one comment with the agent summary" bash -c "grep -q 'RINGKASAN AGEN' '$FAKE_COMMENT' && grep -q 'REVIEW TEXT' '$FAKE_COMMENT' && grep -q 'adopted this PR' '$FAKE_COMMENT'"
assert_true "comment carries the checklist with evidence and the cost line" bash -c "grep -q '\[x\] a — x.rs:1' '$FAKE_COMMENT' && grep -q 'cost' '$FAKE_COMMENT'"
assert_true "labels agent and agent-reviewed added" gh_has '^GH pr edit 129 .*--add-label agent --add-label agent-reviewed'
assert_true "the agent label comes after the export and after the comment" bash -c "[[ $(line_of '^EXPORT') -lt $(line_of '^GH pr comment') && $(line_of '^GH pr comment') -lt $(line_of 'add-label agent ') ]]"
assert_false "the issue is not labelled agent-failed" gh_has 'agent-failed'
assert_eq "outcome adopted" adopted "$(outcomes)"
assert_true "state: complete, last head is the pushed one" bash -c "jq -e '.complete == true and .last_head == \"headB\" and .issue == 108 and .runs == 1' '$STATE/adopt/129.json'"
assert_eq "slot status names the PR from the start (pr.n)" 129 "$(jq -r '.pr.n' "$UI/slots/1.json")"
assert_eq "slot status carries the adoption note" "adopting PR #129 (feat/x)" "$(jq -r '.note' "$UI/slots/1.json")"
assert_eq "slot status shows issue #108 as the issue" 108 "$(jq -r '.issue.n' "$UI/slots/1.json")"
assert_eq "session kept, with the lane that made it, for the shepherd's later turns" "ses1 1" "$(cat "$STATE/sessions/108")"
assert_eq "the same lane resumes it" ses1 "$(K=1 lane_session 108)"
assert_eq "another lane does not: its sandbox cannot see s1" "" "$(K=2 lane_session 108)"
echo ses-old > "$STATE/sessions/108"
assert_eq "a file without a lane (older runs) is not resumed" "" "$(K=1 lane_session 108)"
assert_eq "no file: nothing" "" "$(K=1 lane_session 999)"
echo "ses1 1" > "$STATE/sessions/108"

echo "adoption run: nothing new to push"
reset_run; FAKE_NEWHEAD=headA
( adopt 108 129 ) >/dev/null 2>&1
assert_false "no export when the agent changed nothing" gh_has '^EXPORT'
assert_true "still comments and hands over" gh_has 'add-label agent --add-label agent-reviewed'

echo "adoption run: behind main, clean merge"
reset_run; FAKE_BEHIND=1
( adopt 108 129 ) >/dev/null 2>&1
assert_true "git merge main (never rebase)" gh_has '^SB-MERGE'
assert_false "no agent turn for a clean merge" gh_has 'AGENT merge0'

echo "adoption run: behind main, conflict resolved by an agent turn"
reset_run; FAKE_BEHIND=1 FAKE_MERGE_RC=1
( adopt 108 129 ) >/dev/null 2>&1
assert_true "conflict turn with the shared conflict prompt" grep -q 'git merge main' "$T/msg-merge0"
assert_true "then verify (fix_loop merge0)" gh_has 'FIXLOOP merge0 pr'
assert_eq "the plan starts its own session (sid reset after the conflict turn)" "plan|" "$(grep '^plan|' "$T/sidlog")"
assert_eq "same ending: adopted" adopted "$(outcomes)"
reset_run; FAKE_BEHIND=1 FAKE_MERGE_RC=1 FAKE_VERIFY_FAIL=1
( adopt 108 129 ) >/dev/null 2>&1
assert_true "unresolvable conflict: issue labelled as a failure of this run (conflict)" gh_has '^GH issue edit 108 .*--add-label agent-failed'
assert_false "the PR is not closed" gh_has '^GH pr close'
assert_false "and not labelled agent" gh_has 'add-label agent '

echo "adoption run: checklist not complete"
reset_run; FAKE_CHECKLIST=$T/checklist-part.json
( adopt 108 129 ) >"$T/a2.out" 2>&1; rc=$?
assert_eq "exits 0" 0 "$rc"
assert_true "pushed what it did" gh_has '^EXPORT'
assert_true "comment lists what is missing" bash -c "grep -q 'Not finished' '$FAKE_COMMENT' && grep -q '\[ \] b kurang' '$FAKE_COMMENT'"
assert_false "label agent NOT added" gh_has 'add-label agent'
assert_false "never merged" gh_has '^GH pr merge'
assert_false "the issue is not labelled agent-failed" gh_has 'agent-failed'
assert_eq "outcome adopt_incomplete" adopt_incomplete "$(outcomes)"
assert_true "state: not complete, one run counted" bash -c "jq -e '.complete == false and .runs == 1' '$STATE/adopt/129.json'"
assert_false "an incomplete adoption counts as not complete (open_agent_prs and shepherd skip it)" adopt_complete 129

echo "adoption run: the retry cap counts runs on the same head"
adopt_update 129 headB false
( adopt 108 129 ) >/dev/null 2>&1       # second run, starts on headA again: the human head differs from last_head headB -> reset
assert_eq "a run starting on another head than our last push counts as 1" 1 "$(adopt_get 129 | jq .runs)"

echo "adoption run: the PR head moved while we worked"
reset_run; FAKE_MOVED=1
( adopt 108 129 ) >"$T/a3.out" 2>&1; rc=$?
assert_eq "exits 0" 0 "$rc"
assert_eq "outcome adopt_moved" adopt_moved "$(outcomes)"
assert_false "no comment" gh_has '^GH pr comment'
assert_false "no label" gh_has 'add-label'
assert_false "no failure label on the issue" gh_has 'agent-failed'

echo "adoption run: blocked by an open dependency leaves the PR alone"
reset_run; FAKE_PLAN=$T/plan-blocked.jsonl
( adopt 108 129 ) >/dev/null 2>&1
assert_true "issue waits (agent-blocked)" gh_has '^GH issue edit 108 .*--add-label agent-blocked'
assert_eq "dependency recorded" "[3]" "$(jq -c . "$STATE/blocked/108")"
assert_false "PR not edited, labelled, closed or commented" bash -c "grep -qE '^GH pr (edit|close|comment)' '$FAKE_LOG'"
assert_false "no build turn" gh_has 'AGENT build'
assert_eq "outcome waiting" waiting "$(outcomes)"

echo "plan waits for an issue that waits for this one (#23 <-> #58): plan again, never block"
reset_run; FAKE_PLAN=$T/plan-blocked.jsonl
export FAKE_ISSUES='[{"number":3,"body":"**Bergantung pada**: #108, #29"},{"number":108,"body":"x"},{"number":29,"body":""}]'
( adopt 108 129 ) >/dev/null 2>&1
assert_true "one replan turn" gh_has '^AGENT replan$'
assert_true "...in the same session" grep -qx 'replan|ses1' "$T/sidlog"
assert_true "...told why, and which issue goes first" grep -q '#3 itself waits for this issue' "$T/msg-replan"
assert_true "...with the plan output contract" grep -q 'The output contract of the PLAN step' "$T/msg-replan"
assert_false "no agent-blocked label" gh_has 'agent-blocked'
assert_false "no wait recorded" test -e "$STATE/blocked/108"
assert_true "the replanned issue is built" gh_has '^AGENT build$'
assert_false "no failure" gh_has 'agent-failed'

echo "the replan still waits for the cycle: a human has to break it"
reset_run; FAKE_PLAN=$T/plan-blocked.jsonl; export FAKE_REPLAN=$T/plan-blocked.jsonl
export FAKE_ISSUES='[{"number":3,"body":"**Bergantung pada**: #108"},{"number":108,"body":"x"}]'
( adopt 108 129 ) >/dev/null 2>&1
assert_eq "exactly one replan" 1 "$(grep -c '^AGENT replan$' "$FAKE_LOG")"
assert_true "issue labelled agent-failed" gh_has '^GH issue edit 108 .*--add-label agent-failed'
assert_false "never agent-blocked" gh_has 'agent-blocked'
assert_false "no build turn" gh_has '^AGENT build$'

echo "a cycle through a recorded plan, plus a real dependency: wait for the real one only"
reset_run; FAKE_PLAN=$T/plan-blocked35.jsonl
echo '[7]' > "$STATE/blocked/3"   # a plan recorded #3 waits for #7, and #7 declares it waits for #108
export FAKE_ISSUES='[{"number":3,"body":""},{"number":5,"body":""},{"number":7,"body":"Depends on: #108"},{"number":108,"body":"x"}]'
( adopt 108 129 ) >/dev/null 2>&1
assert_eq "waits for #5 only" "[5]" "$(jq -c . "$STATE/blocked/108" 2>/dev/null)"
assert_false "no replan when a real dependency is left" gh_has '^AGENT replan$'
assert_true "the comment says #3 is not waited for" grep -q '#3 not waited for: that issue itself waits for this one' "$FAKE_ICOMMENT"
assert_true "issue waits (agent-blocked)" gh_has '^GH issue edit 108 .*--add-label agent-blocked'
rm -f "$STATE/blocked/3"

echo "adoption run: verification fails -> failure of the issue, PR untouched and told"
reset_run; FAKE_VERIFY_FAIL=1
( adopt 108 129 ) >/dev/null 2>&1
assert_true "issue labelled agent-failed" gh_has '^GH issue edit 108 .*--add-label agent-failed'
assert_true "the PR gets a comment saying it was left untouched" gh_has "This PR was not changed"
assert_false "PR not closed, not labelled" bash -c "grep -qE '^GH pr (close|edit)' '$FAKE_LOG'"
assert_eq "outcome verify_failed" verify_failed "$(outcomes)"

echo "adoption run: the PR stopped qualifying between pick and run"
reset_run
cp "$FAKE_PRVIEW" "$T/pv.bak"
jq -c '.labels = []' "$T/pv.bak" > "$FAKE_PRVIEW"
( adopt 108 129 ) >/dev/null 2>&1; rc=$?
assert_eq "label gone: exits 0" 0 "$rc"
assert_false "and does nothing" bash -c "grep -qE '^(AGENT|CHECKOUT)' '$FAKE_LOG'"
jq -c '.body = "Closes #108 and Closes #109"' "$T/pv.bak" > "$FAKE_PRVIEW"
reset_run
( adopt 108 129 ) >/dev/null 2>&1
assert_false "a second closing reference now: not adopted" bash -c "grep -qE '^(AGENT|CHECKOUT)' '$FAKE_LOG'"
cp "$T/pv.bak" "$FAKE_PRVIEW"

echo "ordinary issues are unaffected (implement still opens its own PR)"
reset_run
( implement 40 ) >"$T/i1.out" 2>&1; rc=$?
assert_eq "implement returns 0" 0 "$rc"
assert_true "checkout of a fresh agent/issue-40 from main" gh_has '^CHECKOUT agent/issue-40 basesha'
assert_true "plan prompt has no adoption text" bash -c "! grep -q 'PR manusia' '$T/msg-plan'"
assert_true "build prompt is the plain prompt.md" bash -c "! grep -q 'AUDIT first' '$T/msg-build' && grep -q 'BUILD your plan' '$T/msg-build'"
assert_true "gh pr create with agent and agent-reviewed labels" gh_has '^GH pr create .*--label agent --label agent-reviewed'
assert_true "PR body starts with Closes #40" bash -c "head -n1 '$T/log/'*/pr-body.md | grep -q 'Closes #40'"
assert_true "PR body still has summary, checklist and review" bash -c "f=\$(ls '$T/log/'*/pr-body.md | tail -1); grep -q 'RINGKASAN AGEN' \$f && grep -q 'Checklist of what the issue asks for' \$f && grep -q 'REVIEW TEXT' \$f"
assert_false "no adoption state written" bash -c "ls '$STATE/adopt'/*.json"
assert_eq "export is not adopted" "EXPORT agent/issue-40 adopted=0 from=basesha" "$(grep '^EXPORT' "$FAKE_LOG")"

echo "build ends without a commit but with edits: one more turn in the same session, then on to the PR"
reset_run; echo 0 > "$T/commits"; export FAKE_DIRTY=" M crates/x.rs" FAKE_RESUME_COMMITS=2
( implement 40 ) >/dev/null 2>&1; rc=$?
assert_eq "implement returns 0" 0 "$rc"
assert_eq "exactly one complete-commit turn" 1 "$(grep -c '^AGENT complete-commit$' "$FAKE_LOG")"
assert_true "...resuming the build session" grep -qx 'complete-commit|ses1' "$T/sidlog"
assert_true "...told to finish and commit, with the build contract" bash -c "grep -q 'ended without a commit' '$T/msg-complete-commit' && grep -q 'The contract of the BUILD step' '$T/msg-complete-commit'"
assert_true "the PR is opened" gh_has '^GH pr create '
assert_false "no failure label" gh_has 'agent-failed'

echo "build ends without a commit and a clean tree: fails as before, no extra turn"
reset_run; echo 0 > "$T/commits"
( implement 40 ) >/dev/null 2>&1
assert_false "no complete-commit turn" gh_has '^AGENT complete-commit$'
assert_true "issue labelled agent-failed" gh_has '^GH issue edit 40 .*--add-label agent-failed'
assert_eq "outcome no_commit" no_commit "$(outcomes)"

echo "the extra turn still leaves no commit: fails, and only one extra turn"
reset_run; echo 0 > "$T/commits"; export FAKE_DIRTY=" M crates/x.rs"
( implement 40 ) >/dev/null 2>&1
assert_eq "one complete-commit turn" 1 "$(grep -c '^AGENT complete-commit$' "$FAKE_LOG")"
assert_true "issue labelled agent-failed" gh_has '^GH issue edit 40 .*--add-label agent-failed'
assert_eq "outcome no_commit" no_commit "$(outcomes)"
reset_run

# ------------------------------------------------------------------ the export, fast-forward only
echo "export: fast-forward only for an adopted PR"
unset -f export_branch
source "$ORCH/run.sh"; set +e; set +u      # real export_branch again (sourcing re-enables errexit)
stub_mg() {
  mg() {
    echo "MG $*" >> "$FAKE_LOG"
    case "$1" in
      ls-remote) printf '%s\trefs/heads/feat/x\n' "$FAKE_REMOTE" ;;
      rev-parse) echo "$FAKE_BUNDLE_HEAD" ;;
      push) return "${FAKE_PUSH_RC:-0}" ;;
      fetch) return 0 ;;
    esac
    return 0
  }
}
stub_mg
sb() { case "$*" in *"rev-parse HEAD"*) echo "$FAKE_BUNDLE_HEAD" ;; *) true ;; esac; }
mkdir -p "$T/out"; OUT=$T/out; : > "$T/out/branch.bundle"
export FAKE_BUNDLE_HEAD=newsha FAKE_REMOTE=oldsha
ADOPTED=1 adopt_pr=129 CHECKOUT_SHA=oldsha base=basesha
: > "$FAKE_LOG"; FAKE_PUSH_RC=0
export_branch feat/x
assert_eq "pushed, EXPORT_MOVED stays 0" 0 "$EXPORT_MOVED"
assert_true "push goes from a private ref, to the branch" gh_has '^MG push --quiet origin refs/adopt/129:refs/heads/feat/x'
assert_false "push has no --force" gh_has '^MG push.*--force'
assert_true "the bundle is fetched into the private ref, not into the mirror's own branch" gh_has '^MG fetch --quiet .*\+refs/heads/feat/x:refs/adopt/129'
: > "$FAKE_LOG"; export FAKE_REMOTE=humansha
export_branch feat/x; rc=$?
assert_eq "remote head moved: returns (no exit)" 0 "$rc"
assert_eq "EXPORT_MOVED = 1" 1 "$EXPORT_MOVED"
assert_false "and nothing was pushed" gh_has '^MG push'
: > "$FAKE_LOG"; export FAKE_REMOTE=oldsha FAKE_PUSH_RC=1
( export_branch feat/x ) >/dev/null 2>&1; rc=$?
assert_eq "push refused with the head unchanged (permissions, protection): the run fails" 1 "$rc"
ADOPTED=0
: > "$FAKE_LOG"; FAKE_PUSH_RC=0
export_branch agent/issue-40
assert_true "an ordinary agent branch is still force-pushed (it may survive a merged slice)" gh_has '^MG push --quiet --force origin refs/heads/agent/issue-40:refs/heads/agent/issue-40'

# ------------------------------------------------------------------ shepherd and the merge gate
echo "shepherd: only an adopted PR whose checklist is complete"
unset -f mg sb
source "$ORCH/run.sh"; set +e; set +u
sb() { true; }
leave_pr() { echo "LEFT $*" >> "$FAKE_LOG"; return 0; }
gate_halt() { :; }; gate_stop() { :; }; pg_start() { :; }; start_log() { run=$T/log/sh; mkdir -p "$run"; }
mirror_fetch() { :; }
mg() { echo "x"; }
adopt_begin 129 108 headB
: > "$FAKE_LOG"; ADOPTED=0 n=""
shepherd 129 >"$T/s1.out" 2>&1
assert_true "adoption in progress (record, not complete): left alone" grep -q 'checklist is not complete' "$T/s1.out"
assert_false "no CI/merge activity" bash -c "grep -qE '^GH pr (merge|view .*state)' '$FAKE_LOG'"
rm -f "$STATE/adopt/129.json"
: > "$FAKE_LOG"; ADOPTED=0
shepherd 129 >"$T/s2.out" 2>&1
assert_true "a PR that is neither agent/issue-N nor adopted is not shepherded" grep -q 'was not adopted' "$T/s2.out"

echo "open_agent_prs"
cat > "$T/gh-list" <<'X'
#!/usr/bin/env bash
echo '[{"number":10,"headRefName":"agent/issue-5","createdAt":"2026-10-01T00:00:00Z","body":"Closes #5","isCrossRepository":false},
      {"number":11,"headRefName":"feat/a","createdAt":"2026-10-02T00:00:00Z","body":"Closes #6","isCrossRepository":false},
      {"number":12,"headRefName":"feat/b","createdAt":"2026-10-03T00:00:00Z","body":"Closes #7","isCrossRepository":false},
      {"number":13,"headRefName":"feat/c","createdAt":"2026-10-04T00:00:00Z","body":"Closes #8","isCrossRepository":true},
      {"number":14,"headRefName":"agent/issue-9","createdAt":"2026-10-05T00:00:00Z","body":"Closes #9","isCrossRepository":false}]'
X
chmod +x "$T/gh-list"; GH=$T/gh-list
adopt_begin 12 7 h; adopt_update 12 h true      # adopted and complete
adopt_begin 14 9 h                              # an adoption of an agent/issue-N branch, incomplete
assert_eq "agent branch, a complete adoption: yes; labelled-but-never-adopted human PR, fork PR, incomplete adoption: no" \
  "10 5|12 7" "$(open_agent_prs | paste -sd'|')"

echo "give_up_pr never closes or deletes a human's branch"
unset -f leave_pr
fail_issue() { echo "FAILISSUE $*" >> "$FAKE_LOG"; exit 0; }   # the real one exits too
GH=$T/gh-fake; : > "$FAKE_LOG"; ADOPTED=1
adopt_begin 129 108 headB
( give_up_pr 129 ci_failed "CI failed" )
assert_false "no pr close" gh_has '^GH pr close'
assert_true "the lane lets go: agent labels removed" gh_has '^GH pr edit 129 .*--remove-label agent --remove-label agent-reviewed --remove-label agent-adopt'
assert_true "the issue is failed with the reason" gh_has '^FAILISSUE ci_failed'
assert_false "the record is forgotten (a new label starts clean)" adopt_known 129
ADOPTED=0; : > "$FAKE_LOG"
( give_up_pr 77 ci_failed "CI failed" )
assert_true "an agent PR is closed with its branch, as before" gh_has '^GH pr close 77 .*--delete-branch'

echo "prompts and install"
assert_true "adopt.md exists with the audit-first contract" bash -c "grep -q 'AUDIT' '$ORCH/prompts/adopt.md' && grep -q 'agent-checklist.json' '$ORCH/prompts/adopt.md' && grep -q 'Keep the author.s design' '$ORCH/prompts/adopt.md'"
assert_true "the installer ships adopt.md" bash -c "grep -q 'prompts/adopt.md' '$ORCH/../deploy/orchestrator-install.sh' && grep -q 'review adopt; do put' '$ORCH/../deploy/orchestrator-install.sh'"
finish
