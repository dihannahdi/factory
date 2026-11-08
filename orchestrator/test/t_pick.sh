#!/usr/bin/env bash
# The one classifier: classes, order, one-shot queue, adaptive family preference, and that
# `run.sh DRY_PICK` picks what sync.sh publishes as order 1 in github.json.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/lib.sh"
set +e

# --- fixture: gh-shaped issues / PRs
mkissue() {  # n title milestone labels-csv [assignee]
  jq -nc --argjson n "$1" --arg t "$2" --arg m "$3" --arg l "$4" --arg a "${5:-}" '
    {number: $n, title: $t, labels: ($l | split(",") | map(select(. != "") | {name: .})),
     milestone: (if $m == "" then null else {title: $m} end), assignees: (if $a == "" then [] else [{login: $a}] end)}'
}
{
  mkissue 1  "[ENG-01] satu" M1 "P0"
  mkissue 2  "[ENG-02] dua" M1 "P0"
  mkissue 3  "[LAY-01] tiga" M1 "P0"
  mkissue 4  "[ELE-01] empat" M1 "P1"
  mkissue 5  "[OUT-01] no milestone" "" "P0"
  mkissue 6  "[OUT-02] ada assignee" M1 "P0" someone
  mkissue 7  "[OUT-03] failed" M1 "P0,agent-failed"
  mkissue 8  "[OUT-04] waiting" M1 "P0,agent-blocked"
  mkissue 9  "[OUT-05] skipped in the console" M1 "P0"
  mkissue 10 "[OUT-06] label skip" M1 "P0,agent-skip"
  mkissue 11 "[ENG-11] diambil PR tag" M1 "P0"
  mkissue 12 "[ENG-12] diambil PR nomor" M1 "P0"
  mkissue 13 "[ENG-13] being worked by lane 2" M1 "P0"
  mkissue 14 "[OUT-07] queued" M2 "P2,agent-failed"
  mkissue 15 "[OUT-08] baru di-merge" M1 "P0"
  mkissue 16 "[ENG-05] lima" M1 "P0"
  mkissue 17 "[ELE-09] queue entry already used" M2 "P1"
  mkissue 18 "no tag" M1 "P0"
  mkissue 19 "[OUT-09] the 1st, #190 not #19" M1 "P0"
} | jq -sc . > "$T/issues.json"
cat > "$T/prs.json" <<'J'
[{"number":200,"title":"[ENG-11] partial","body":"Refs #11","labels":[{"name":"agent"}],"headRefName":"agent/issue-11","headRefOid":"aaa","createdAt":"2026-10-01T00:00:00Z","mergeable":"MERGEABLE","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}],"url":"u"},
 {"number":201,"title":"Perbaikan manual","body":"Closes #12.\nlihat juga #120. Irisan berikutnya butuh #16 dulu.","labels":[],"headRefName":"fix/x","headRefOid":"bbb","createdAt":"2026-10-02T00:00:00Z","mergeable":"UNKNOWN","statusCheckRollup":[],"url":"u"}]
J
export FAKE_GH_DIR=$T
cp "$T/issues.json" "$T/gh-issues"; mkdir -p "$T/gh" ; cp "$T/issues.json" "$T/gh/issues.json"; cp "$T/prs.json" "$T/gh/prs.json"; export FAKE_GH_DIR=$T/gh

# --- local state: control, consumed, claims, blocked
export NOW=1792130000
cat > "$CTL/control.json" <<'J'
{"v":1,"agents":3,"models":["opencode/deepseek-v4.1-flash-free"],"model_mode":"ordered","paused":false,
 "queue":[{"n":14,"at":"2026-10-16T05:00:00Z"},{"n":17,"at":"2026-10-16T05:00:00Z"}],"skip":[9],"resume_ack":null}
J
echo '{"17":"2026-10-16T05:01:10Z"}' > "$UI/consumed.json"       # queued #17 was already started
mkdir -p "$STATE/claims" "$STATE/blocked"
echo '{"slot":2,"run_id":"inv-2","at":1,"state":"active","pid":1}' > "$STATE/claims/13"
echo '{"slot":1,"run_id":"inv-1","at":1,"state":"done","until":1792130500}' > "$STATE/claims/15"
echo '[1]' > "$STATE/blocked/8"                                  # #8 waits for #1 (open)
export FAKE_ACTIVE=active FAKE_INV=inv-2
control_load

d=$T/work; mkdir -p "$d"
cp "$T/issues.json" "$d/issues.json"; cp "$T/prs.json" "$d/prs.json"
gather_local "$d"
out=$(classify_run "$d")
cls() { jq -r --argjson n "$1" '.[] | select(.n == $n) | .class' <<<"$out"; }
ord() { jq -r --argjson n "$1" '.[] | select(.n == $n) | .order' <<<"$out"; }

echo "classes"
assert_eq "#1 eligible" eligible "$(cls 1)"
assert_eq "#5 no milestone: ineligible" ineligible "$(cls 5)"
assert_eq "#6 assigned: ineligible" ineligible "$(cls 6)"
assert_eq "#7 agent-failed: failed" failed "$(cls 7)"
assert_eq "#8 agent-blocked + open dep: blocked" blocked "$(cls 8)"
assert_eq "#8 reason names the dep" "waiting for #1" "$(jq -r '.[] | select(.n == 8) | .reason' <<<"$out")"
assert_json_eq "#8 deps" '[1]' "$(jq -c '.[] | select(.n == 8) | .deps' <<<"$out")"
assert_eq "#9 control.skip: skipped" skipped "$(cls 9)"
assert_eq "#10 label agent-skip: skipped" skipped "$(cls 10)"
assert_eq "#11 open PR names its [TAG]: taken" taken "$(cls 11)"
assert_json_eq "#11 taken_by" '[200]' "$(jq -c '.[] | select(.n == 11) | .taken_by' <<<"$out")"
assert_eq "#12 open PR says Closes #12: taken" taken "$(cls 12)"
assert_eq "#1 is not taken by '#12' or '#120' in PR texts" eligible "$(cls 1)"
assert_eq "#12 only #12, not #120" "[201]" "$(jq -c '.[] | select(.n == 12) | .taken_by' <<<"$out")"
assert_eq "#16 named only in prose ('butuh #16'): not taken" eligible "$(cls 16)"
assert_json_eq "#16 taken_by empty" '[]' "$(jq -c '.[] | select(.n == 16) | .taken_by' <<<"$out")"
assert_eq "#13 live claim: running" running "$(cls 13)"
assert_eq "#13 claimed_by lane 2" 2 "$(jq -r '.[] | select(.n == 13) | .claimed_by' <<<"$out")"
assert_eq "#14 queued (ignores agent-failed)" queued "$(cls 14)"
assert_eq "#15 tombstone: ineligible" ineligible "$(cls 15)"
assert_eq "#17 queue entry already consumed: ordinary (eligible)" eligible "$(cls 17)"
assert_eq "tag and family derived" "ELE-01 ELE" "$(jq -r '.[] | select(.n == 4) | "\(.tag) \(.family)"' <<<"$out")"
assert_eq "no tag: null family" null "$(jq -r '.[] | select(.n == 18) | .family' <<<"$out")"
assert_eq "priority from label" P1 "$(jq -r '.[] | select(.n == 4) | .priority' <<<"$out")"

echo "order (queued first, then milestone, priority, family not busy, number)"
assert_eq "#14 queued is order 1" 1 "$(ord 14)"
assert_eq "order is null for classes that are not picked" "null null null null null" "$(ord 5) $(ord 7) $(ord 8) $(ord 11) $(ord 13)"
# M1/P0 eligible: 1 2 3 16 18 19. ENG is busy (lane 2 works #13): LAY-01 (#3), tagless #18, OUT-09 (#19) go before ENG ones.
assert_json_eq "eligible order" '[14,3,18,19,1,2,16,4,17]' "$(jq -c '[.[] | select(.order != null)] | sort_by(.order) | map(.n)' <<<"$out")"
assert_eq "first order is #14" 14 "$(jq -r '[.[] | select(.order != null)] | sort_by(.order) | first | .n' <<<"$out")"

echo "adaptive pick without a busy family: plain number order"
echo '{"slot":2,"run_id":"inv-2","at":1,"state":"active","pid":1}' > "$STATE/claims/3"
rm -f "$STATE/claims/13"
gather_local "$d"
out=$(classify_run "$d")
assert_json_eq "LAY is busy now (lane works #3), ENG free: ENG first" '[14,1,2,13,16,18,19,4,17]' "$(jq -c '[.[] | select(.order != null)] | sort_by(.order) | map(.n)' <<<"$out")"

echo "queue is one-shot"
rm -f "$STATE/claims/3"
echo '{"14":"2026-10-16T05:00:01Z"}' > "$UI/consumed.json"
gather_local "$d"
out=$(classify_run "$d")
assert_eq "#14 consumed: back to failed" failed "$(cls 14)"
echo '{"14":"2026-10-16T04:59:59Z"}' > "$UI/consumed.json"
gather_local "$d"
out=$(classify_run "$d")
assert_eq "re-queued after consumption (at is later): queued again" queued "$(cls 14)"

echo "pick_issue and DRY_PICK use the same classifier"
echo '{}' > "$UI/consumed.json"
rm -f "$STATE/claims/13" "$STATE/claims/3"
echo '{"slot":2,"run_id":"inv-2","at":1,"state":"active","pid":1}' > "$STATE/claims/13"
assert_eq "pick_issue: first order and its class" "14 queued" "$(pick_issue)"
export GH_TOKEN_FILE=$T/token; echo tok > "$GH_TOKEN_FILE"
export SANDBOX=$T/none PROMPTS=$T/none
dry=$(DRY_PICK=1 bash "$ORCH/run.sh" --slot 1 2>/dev/null)
assert_eq "DRY_PICK prints it" "would pick #14" "$dry"
# the published list (sync) must agree
export OPENCODE_CONF=$T/opencode.json OPENCODE_TEMPLATE=$ORCH/opencode.json FAKE_CURL_DIR=$T/curl
mkdir -p "$T/curl"
echo '{"data":[{"id":"a-free"}]}' > "$T/curl/zen.json"
echo '{"opencode":{"models":{"a-free":{"name":"A","cost":{"input":0,"output":0},"limit":{"context":1,"output":2}}}}}' > "$T/curl/modelsdev.json"
bash "$ORCH/sync.sh" >/dev/null 2>&1
assert_eq "github.json: first order is the same issue" 14 "$(jq -r '[.issues[] | select(.order != null)] | sort_by(.order) | first | .n' "$UI/github.json")"
assert_eq "github.json: ok" true "$(jq -r .ok "$UI/github.json")"
dry2=$(DRY_PICK=1 bash "$ORCH/run.sh" --slot 3 2>/dev/null)
assert_eq "DRY_PICK from another lane agrees" "$dry" "$dry2"
finish
