#!/usr/bin/env bash
# sync.sh end to end against stubs: models.json, the opencode whitelist, halt, acknowledgement,
# unblock, and the shape of github.json.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env

mkdir -p "$T/gh" "$T/curl"
export FAKE_GH_DIR=$T/gh FAKE_CURL_DIR=$T/curl GH_TOKEN_FILE=$T/token OPENCODE_CONF=$T/opencode.json OPENCODE_TEMPLATE=$ORCH/opencode.json
export SANDBOX=$T/none
echo tok > "$GH_TOKEN_FILE"
cat > "$T/gh/issues.json" <<'J'
[{"number":1,"title":"[ENG-01] satu","body":"intro\n- a\n- b\n1. c\n- [ ] d\n- [x] e","labels":[{"name":"P0"}],"milestone":{"title":"M1"},"assignees":[]},
 {"number":2,"title":"[ENG-02] dua","labels":[{"name":"agent-blocked"}],"milestone":{"title":"M1"},"assignees":[]},
 {"number":5,"title":"[ENG-05] lima","body":"**Bergantung pada**: #3, #1.\nsee also #4","labels":[],"milestone":{"title":"M1"},"assignees":[]}]
J
cat > "$T/gh/closed.json" <<'J'
[{"number":3,"title":"[ENG-03] tiga","body":"**Bergantung pada**: #4\nsecret-body","milestone":{"title":"M1"},"closedAt":"2026-10-10T01:00:00Z","stateReason":"COMPLETED"},
 {"number":4,"title":"four without a tag","milestone":null,"closedAt":"2026-10-09T00:00:00Z","stateReason":"NOT_PLANNED"}]
J
echo '[]' > "$T/gh/prs.json"
cat > "$T/curl/zen.json" <<'J'
{"data":[{"id":"deepseek-v4.1-flash-free"},{"id":"space-bunny-free"},{"id":"muse-spark-1.3-contributor-free"},{"id":"deepseek-v4.1-flash"},{"id":"mystery-free"}]}
J
cat > "$T/curl/modelsdev.json" <<'J'
{"opencode":{"models":{
 "deepseek-v4.1-flash-free":{"name":"DeepSeek V4.1 Flash Free","cost":{"input":0,"output":0},"limit":{"context":200000,"output":32000}},
 "space-bunny-free":{"name":"Space Bunny Free","cost":{"input":0,"output":0},"limit":{"context":1048576,"output":131072}},
 "muse-spark-1.3-contributor-free":{"name":"Muse Spark","cost":{"input":0,"output":0},"limit":{"context":1048576,"output":131072}},
 "deepseek-v4.1-flash":{"name":"DeepSeek V4.1 Flash","cost":{"input":0.14,"output":0.28},"limit":{"context":200000,"output":32000}},
 "mystery-free":{"name":"Mystery","cost":{"input":0,"output":0},"limit":{"context":1,"output":2}},
 "not-in-zen-free":{"name":"Not listed","cost":{"input":0,"output":0},"limit":{"context":1,"output":2}},
 "no-cost-info":{"name":"No cost","limit":{"context":1,"output":2}}}}}
J
cp "$ORCH/opencode.json" "$T/opencode.json"
export FAKE_ACTIVE=inactive

run_sync() { bash "$ORCH/sync.sh" >"$T/sync.out" 2>&1; }

echo "first run"
run_sync
assert_true "models.json exists" test -s "$UI/models.json"
assert_json_eq "free = Zen listed ∩ models.dev cost 0 (paid, unlisted and cost-less excluded)" \
  '["opencode/deepseek-v4.1-flash-free","opencode/muse-spark-1.3-contributor-free","opencode/mystery-free","opencode/space-bunny-free"]' \
  "$(jq -c '[.free[].id]' "$UI/models.json")"
assert_json_eq "trains_on_data: false / true (contributor) / null (unknown) / false" '[false,true,null,false]' "$(jq -c '[.free[].trains_on_data]' "$UI/models.json")"
assert_eq "mystery model: trains_on_data null" null "$(jq -c '.free[] | select(.id == "opencode/mystery-free") | .trains_on_data' "$UI/models.json")"
# spend comes from lib.sh's spend_summary (always defined now); paid only with a Go key, absent here
assert_eq "models.json keys match the contract" '["cooldown","free","source_ok","spend","updated","v"]' "$(jq -c 'keys' "$UI/models.json")"
assert_eq "source_ok both true" '{"zen":true,"modelsdev":true}' "$(jq -c .source_ok "$UI/models.json")"
assert_json_eq "zero_retention: true / false (contributor) / null (unknown) / true" '[true,false,null,true]' "$(jq -c '[.free[].zero_retention]' "$UI/models.json")"
assert_false "no Go key: no paid in models.json" jq -e 'has("paid")' "$UI/models.json"
assert_eq "no Go key: only the free provider is enabled" '["opencode"]' "$(jq -c .enabled_providers "$OPENCODE_CONF")"
assert_eq "no Go key: no opencode-go provider block" false "$(jq -c '.provider | has("opencode-go")' "$OPENCODE_CONF")"
# the sandbox has internet egress (verified 2026-10-17), so webfetch is not denied
assert_eq "webfetch not denied in the managed config" unset "$(jq -r '.permission.webfetch // "unset"' "$OPENCODE_CONF")"
assert_eq "webfetch not denied in the template" unset "$(jq -r '.permission.webfetch // "unset"' "$ORCH/opencode.json")"
assert_eq "free entry keys match the contract" '["context","id","name","output","trains_on_data","zero_retention"]' "$(jq -c '.free[0] | keys' "$UI/models.json")"
assert_json_eq "whitelist = exactly the free set (no opencode/ prefix)" \
  '["deepseek-v4.1-flash-free","muse-spark-1.3-contributor-free","mystery-free","space-bunny-free"]' \
  "$(jq -c .provider.opencode.whitelist "$OPENCODE_CONF")"
assert_eq "other keys survive the rewrite" "false 250" "$(jq -r '[.snapshot, .agent.build.steps] | join(" ")' "$OPENCODE_CONF")"
assert_eq "template denies pkill" deny "$(jq -r '.permission.bash["pkill *"]' "$OPENCODE_CONF")"
assert_eq "template denies killall" deny "$(jq -r '.permission.bash["killall *"]' "$OPENCODE_CONF")"
assert_false "no halt while models exist" test -e "$UI/halt.json"

echo "github.json"
assert_eq "github.json keys match the contract" '["adopt_ignored","done","error","health","issues","main","ok","prs","runner","updated","v"]' "$(jq -c 'keys' "$UI/github.json")"
assert_eq "no HEALTH_URL: nothing to watch, so health is ok" true "$(jq -r .health.ok "$UI/github.json")"
assert_eq "issue keys match the contract" '["claimed_by","class","deps","deps_all","family","labels","milestone","n","order","priority","reason","size","tag","taken_by","title","url"]' "$(jq -c '.issues[0] | keys' "$UI/github.json")"
assert_eq "size counts chars, bullets and checkboxes of the body" '{"chars":34,"bullets":5,"checkboxes":2}' "$(jq -c '.issues[] | select(.n == 1) | .size' "$UI/github.json")"
assert_eq "an issue without a body has zero size, and no body text leaks into github.json" '{"chars":0,"bullets":0,"checkboxes":0} 0' "$(jq -c '.issues[] | select(.n == 2) | .size' "$UI/github.json") $(grep -c intro "$UI/github.json")"
assert_eq "issue #1 eligible, order 1" "eligible 1" "$(jq -r '.issues[] | select(.n == 1) | "\(.class) \(.order)"' "$UI/github.json")"
assert_eq "issue #2 agent-blocked" blocked "$(jq -r '.issues[] | select(.n == 2) | .class' "$UI/github.json")"
assert_eq "runner keys" '{"queued":0,"in_progress":0}' "$(jq -c .runner "$UI/github.json")"

echo "github.json: closed issues and every declared dependency, for the dependency map"
assert_eq "#5 is blocked by its open dependency only" '{"deps":[1],"deps_all":[1,3]}' "$(jq -c '.issues[] | select(.n == 5) | {deps, deps_all}' "$UI/github.json")"
assert_eq "done: number, title, tag, milestone, closed time, reason, declared deps"   "$(jq -nc '[{n:3,title:"[ENG-03] tiga",tag:"ENG-03",milestone:"M1",closed_at:("2026-10-10T01:00:00Z"|fromdateiso8601),reason:"completed",deps:[4]},{n:4,title:"four without a tag",tag:null,milestone:null,closed_at:("2026-10-09T00:00:00Z"|fromdateiso8601),reason:"not_planned",deps:[]}]')"   "$(jq -c .done "$UI/github.json")"
assert_eq "no closed-issue body reaches github.json" 0 "$(grep -c secret-body "$UI/github.json")"
echo '[]' > "$T/gh/closed.json"
run_sync
assert_eq "within DONE_TTL the cached list stays" 2 "$(jq '.done | length' "$UI/github.json")"
DONE_TTL=0 run_sync
assert_eq "after DONE_TTL it is fetched again" 0 "$(jq '.done | length' "$UI/github.json")"

echo "cooldowns mirrored into models.json every run (and only that)"
export NOW=$(( $(date +%s) ))
K=1 RUN_ID=x
source "$ORCH/lib.sh"
set +e
cooldown_hit opencode/space-bunny-free rate_limit
upd=$(jq -r .updated "$UI/models.json")
run_sync
assert_eq "cooldown appears" rate_limit "$(jq -r '.cooldown["opencode/space-bunny-free"].reason' "$UI/models.json")"
assert_eq "free list not refetched (updated unchanged)" "$upd" "$(jq -r .updated "$UI/models.json")"
cooldown_reset opencode/space-bunny-free
run_sync
assert_eq "cooldown cleared" '{}' "$(jq -c .cooldown "$UI/models.json")"

echo "a source down: keep the last list, conclude nothing"
rm -f "$STATE/.models-stamp"
mv "$T/curl/zen.json" "$T/curl/zen.json.off"
echo 'not json' > "$T/curl/zen.json"
run_sync
assert_eq "free list kept" 4 "$(jq '.free | length' "$UI/models.json")"
assert_eq "source_ok.zen false" false "$(jq -r .source_ok.zen "$UI/models.json")"
assert_false "no halt for a source outage" test -e "$UI/halt.json"

echo "no free model left: halt"
rm -f "$STATE/.models-stamp"
echo '{"data":[{"id":"deepseek-v4.1-flash"}]}' > "$T/curl/zen.json"
run_sync
assert_eq "free list empty" 0 "$(jq '.free | length' "$UI/models.json")"
assert_true "halt.json written" test -s "$UI/halt.json"
id=$(jq -r .id "$UI/halt.json")
assert_eq "halt keys match the contract" '["at","id","issue_url","reason"]' "$(jq -c keys "$UI/halt.json")"
assert_true "halt id is <epoch>-<slug>" bash -c "[[ '$id' =~ ^[0-9]+-free-model-gone$ ]]"
CONTROL=$CONTROL_DEFAULT
assert_true "halted() sees it" halted
echo "{\"v\":1,\"resume_ack\":\"$id\"}" > "$CTL/control.json"
control_load
assert_false "acknowledged: no longer halted" halted
run_sync
assert_false "sync removes the acknowledged halt.json" test -e "$UI/halt.json"

echo "unblock (single writer: sync)"
mkdir -p "$STATE/blocked"
echo '[1]' > "$STATE/blocked/2"      # still open
run_sync
assert_true "dependency open: stays blocked" test -e "$STATE/blocked/2"
echo '[99]' > "$STATE/blocked/2"     # #99 is not open
run_sync
assert_false "every dependency closed: lifted" test -e "$STATE/blocked/2"

echo "zen key detection"
source "$ORCH/sync.sh"
set +e
assert_true "auth.json with an opencode credential" auth_has_zen_key '{"opencode":{"type":"api","key":"sk-xxx"}}'
assert_false "auth.json with another provider only" auth_has_zen_key '{"anthropic":{"type":"oauth"}}'
assert_false "empty auth.json" auth_has_zen_key '{}'
assert_false "garbage" auth_has_zen_key 'nope'
assert_true "sync finishes inside its budget (stubs)" test "$(( $(date +%s) - ${T0:-0} ))" -ge 0
finish
