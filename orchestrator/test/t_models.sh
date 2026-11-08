#!/usr/bin/env bash
# Error classification, cooldown math, model selection, adaptive agent cap, ranking.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/lib.sh"
set +e

echo "err_class"
ev() { printf '%s\n' "$1" > "$T/ev.jsonl"; err_class "$T/ev.jsonl"; }
assert_eq "no events: none" none "$(ev '')"
assert_eq "no error event: none" none "$(ev '{"type":"text","part":{"text":"hi"}}')"
assert_eq "statusCode 429" rate_limit "$(ev '{"type":"error","error":{"name":"APIError","data":{"message":"x","statusCode":429}}}')"
assert_eq "statusCode 429 as string" rate_limit "$(ev '{"type":"error","error":{"name":"APIError","data":{"message":"x","statusCode":"429"}}}')"
assert_eq "message: Rate limit exceeded" rate_limit "$(ev '{"type":"error","error":{"name":"E","data":{"message":"Rate limit exceeded, retry later"}}}')"
assert_eq "name: FreeUsageLimitError" rate_limit "$(ev '{"type":"error","error":{"name":"FreeUsageLimitError","data":{"message":"limit"}}}')"
assert_eq "message: quota" rate_limit "$(ev '{"type":"error","error":{"name":"E","data":{"message":"You exceeded your current quota"}}}')"
assert_eq "message: Too many requests" rate_limit "$(ev '{"type":"error","error":{"name":"E","data":{"message":"Too Many Requests"}}}')"
assert_eq "message: 429 in text" rate_limit "$(ev '{"type":"error","error":{"name":"E","data":{"message":"HTTP 429 from upstream"}}}')"
assert_eq "500 is other" other "$(ev '{"type":"error","error":{"name":"APIError","data":{"message":"internal error","statusCode":500}}}')"
assert_eq "'generate' is not a rate limit" other "$(ev '{"type":"error","error":{"name":"E","data":{"message":"failed to generate a response"}}}')"
assert_eq "400 is other" other "$(ev '{"type":"error","error":{"name":"APIError","data":{"message":"messages: unexpected tool_use","statusCode":400}}}')"
printf 'garbage\n{"type":"error","error":{"data":{"statusCode":429}}}\n' > "$T/ev.jsonl"
assert_eq "non-JSON lines are skipped" rate_limit "$(err_class "$T/ev.jsonl")"

echo "cooldown math"
assert_eq "rate limit #1: 10 min" "1000600 1" "$(cooldown_next rate_limit 0 1000000)"
assert_eq "rate limit #2: 20 min" "1001200 2" "$(cooldown_next rate_limit 1 1000000)"
assert_eq "rate limit #3: 40 min" "1002400 3" "$(cooldown_next rate_limit 2 1000000)"
assert_eq "rate limit #4: 80 min" "1004800 4" "$(cooldown_next rate_limit 3 1000000)"
assert_eq "rate limit #5: capped at 2 h" "1007200 5" "$(cooldown_next rate_limit 4 1000000)"
assert_eq "rate limit #30: still 2 h" "1007200 30" "$(cooldown_next rate_limit 29 1000000)"
assert_eq "other #1: 20 min" "1001200 1" "$(cooldown_next other 0 1000000)"
assert_eq "other #2: 40 min" "1002400 2" "$(cooldown_next other 1 1000000)"
assert_eq "other #5: 5 h 20 min" "1019200 5" "$(cooldown_next other 4 1000000)"
assert_eq "other #6: capped at 6 h" "1021600 6" "$(cooldown_next other 5 1000000)"
assert_eq "other #40: still 6 h" "1021600 40" "$(cooldown_next other 39 1000000)"

echo "cooldown files"
export NOW=2000000
M=opencode/deepseek-v4.1-flash-free
assert_eq "sanitized file name" "$STATE/cooldown/opencode_deepseek-v4.1-flash-free" "$(cooldown_file "$M")"
assert_eq "no file: until 0" 0 "$(cooldown_until "$M")"
assert_false "not cooling" is_cooling "$M"
cooldown_hit "$M" rate_limit
assert_eq "hit: file is '<until> <k> <reason>'" "2000600 1 rate_limit" "$(cat "$(cooldown_file "$M")")"
assert_true "now cooling" is_cooling "$M"
cooldown_hit "$M" rate_limit
assert_eq "second hit doubles (k persists)" "2001200 2 rate_limit" "$(cat "$(cooldown_file "$M")")"
cooldown_hit "$M" other
assert_eq "third hit, other reason: k 3 -> 20min<<2 = 80 min" "2004800 3 other" "$(cat "$(cooldown_file "$M")")"
assert_json_eq "cooldown_json mirrors it" '{"opencode/deepseek-v4.1-flash-free":{"until":2004800,"reason":"other"}}' "$(cooldown_json "$M" opencode/other-free)"
export NOW=2005000
assert_false "expired cooldown is not cooling" is_cooling "$M"
assert_json_eq "expired cooldown not mirrored" '{}' "$(cooldown_json "$M")"
cooldown_reset "$M"
assert_false "success resets: file gone" test -e "$(cooldown_file "$M")"
cooldown_hit "$M" rate_limit
assert_eq "after reset k starts again" "2005600 1 rate_limit" "$(cat "$(cooldown_file "$M")")"

echo "models_effective"
free='["opencode/a-free","opencode/b-free","opencode/c-free"]'
assert_eq "intersection keeps control order" '["opencode/c-free","opencode/a-free"]' "$(models_effective '["opencode/c-free","opencode/gone","opencode/a-free"]' "$free" '[]')"
assert_eq "none of control is free: first free" '["opencode/a-free"]' "$(models_effective '["opencode/gone"]' "$free" '[]')"
assert_eq "cooling goes last" '["opencode/b-free","opencode/a-free"]' "$(models_effective '["opencode/a-free","opencode/b-free"]' "$free" '["opencode/a-free"]')"
assert_eq "all cooling: order kept" '["opencode/a-free","opencode/b-free"]' "$(models_effective '["opencode/a-free","opencode/b-free"]' "$free" '["opencode/a-free","opencode/b-free"]')"
assert_eq "no free models: empty" '[]' "$(models_effective '["opencode/a-free"]' '[]' '[]')"

echo "effective_agents_calc"
assert_eq "plain" 2 "$(effective_agents_calc 2 0 100 0)"
assert_eq "capped at 3" 3 "$(effective_agents_calc 9 0 100 0)"
assert_eq "all rate limited: 1" 1 "$(effective_agents_calc 3 1 100 0)"
assert_eq "disk below 20G: nothing builds" 0 "$(effective_agents_calc 3 0 19 0)"
assert_eq "disk below 20G: nothing, even for one agent" 0 "$(effective_agents_calc 1 0 5 0)"
assert_eq "disk 20-39G: 1" 1 "$(effective_agents_calc 3 0 39 0)"
assert_eq "disk exactly 40G: unchanged" 3 "$(effective_agents_calc 3 0 40 0)"
assert_eq "3 queued runner jobs: 1" 1 "$(effective_agents_calc 3 0 100 3)"
assert_eq "2 queued: unchanged" 3 "$(effective_agents_calc 3 0 100 2)"
assert_eq "agents 0 stays 0" 0 "$(effective_agents_calc 0 1 5 9)"

echo "rl_recent_all"
export NOW=3000000
cat > "$T/stats.jsonl" <<'S'
{"ts":2999500,"kind":"call","model":"opencode/a","rate_limited":true}
{"ts":2999600,"kind":"call","model":"opencode/b","rate_limited":true}
{"ts":2990000,"kind":"call","model":"opencode/c","rate_limited":true}
{"ts":2999900,"kind":"call","model":"opencode/c","rate_limited":false}
S
assert_true "a and b both limited inside 15 min" rl_recent_all "$T/stats.jsonl" 900 opencode/a opencode/b
assert_false "c limited too long ago" rl_recent_all "$T/stats.jsonl" 900 opencode/a opencode/c
assert_false "no models: false" rl_recent_all "$T/stats.jsonl" 900

echo "rank_models"
cat > "$T/stats.jsonl" <<'S'
{"ts":2999000,"kind":"outcome","outcome":"pr","model":"opencode/a","issue":1}
{"ts":2999000,"kind":"outcome","outcome":"pr","model":"opencode/a","issue":2}
{"ts":2999000,"kind":"outcome","outcome":"no_commit","model":"opencode/b","issue":3}
{"ts":2999000,"kind":"outcome","outcome":"pr","model":"opencode/b","issue":4}
S
assert_eq "merged wins over unmerged" '["opencode/a","opencode/b"]' "$(rank_models '["opencode/b","opencode/a"]' '{"1":"MERGED","2":"MERGED","4":"CLOSED"}' "$T/stats.jsonl")"
echo '{"ts":2999500,"kind":"call","model":"opencode/a","model_error":true}' >> "$T/stats.jsonl"
assert_eq "a model that errored in the last 2 h goes last" '["opencode/b","opencode/a"]' "$(rank_models '["opencode/b","opencode/a"]' '{"1":"MERGED","2":"MERGED","4":"CLOSED"}' "$T/stats.jsonl")"

echo "jsonl helpers (real opencode sample)"
f=$FIX/log/plan-0.jsonl
assert_eq "first session id" ses_ebcbc3e02ffef6madVZtWhFFCS "$(jsonl_first_session "$f")"
assert_false "sample has cost 0" jsonl_cost_positive "$f"
printf '%s\n' '{"type":"step_finish","part":{"cost":0.002,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}' > "$T/c.jsonl"
assert_true "cost > 0 trips the wire" jsonl_cost_positive "$T/c.jsonl"
tok=$(jsonl_tokens "$f")
assert_eq "tokens: four keys" '["cache_read","input","output","reasoning"]' "$(jq -c 'keys' <<<"$tok")"
assert_true "tokens from the sample are non-zero" jq -e '.input > 0' <<<"$tok"

echo "models_eligible (SCHEMA 3.3)"
mj() { printf '%s\n' "$1" > "$T/models.json"; models_eligible "$T/models.json"; }
NEW='{"v":1,"free":[{"id":"opencode/a-free","zero_retention":true},{"id":"opencode/meta-contributor","zero_retention":false},{"id":"opencode/nemotron-free","zero_retention":null},{"id":"opencode/b-free","zero_retention":true}],"paid":[{"id":"opencode-go/m1","zero_retention":true}]}'
assert_eq "only zero_retention == true; paid first" '["opencode-go/m1","opencode/a-free","opencode/b-free"]' "$(mj "$NEW")"
assert_eq "no paid key" '["opencode/a-free"]' "$(mj '{"v":1,"free":[{"id":"opencode/a-free","zero_retention":true},{"id":"opencode/x","zero_retention":false}]}')"
assert_eq "old shape (no zero_retention anywhere): every free id, as before" '["opencode/a-free","opencode/c-free"]' "$(mj '{"v":1,"free":[{"id":"opencode/a-free","trains_on_data":false},{"id":"opencode/c-free"}]}')"
assert_eq "a paid id outside opencode-go/ is ignored" '["opencode/a-free"]' "$(mj '{"v":1,"free":[{"id":"opencode/a-free","zero_retention":true}],"paid":[{"id":"opencode/sneaky","zero_retention":true}]}')"
assert_eq "missing file: nothing" '[]' "$(models_eligible "$T/nope.json")"
elig=$(mj "$NEW")
assert_eq "control order is kept, ineligible dropped" '["opencode/b-free","opencode/a-free"]' "$(models_effective '["opencode/b-free","opencode/meta-contributor","opencode/a-free"]' "$elig" '[]')"
assert_eq "none of control eligible: the first eligible (paid)" '["opencode-go/m1"]' "$(models_effective '["opencode/meta-contributor"]' "$elig" '[]')"
assert_eq "...skipping a cooling paid model" '["opencode/a-free"]' "$(models_effective '["opencode/meta-contributor"]' "$elig" '["opencode-go/m1"]')"
assert_true "control accepts opencode-go ids" bash -c "source '$ORCH/lib.sh'; echo '{\"v\":1,\"models\":[\"opencode-go/deepseek-v4.1-flash\"]}' > '$T/c.json'; CTL='$T'; mv '$T/c.json' '$T/control.json'; control_validate '$T/control.json' | grep -q opencode-go"

echo "spend_summary and spend_blocked_until"
export NOW=10000000
cat > "$STATE/spend.jsonl" <<'S'
{"ts":9999000,"slot":1,"issue":1,"model":"opencode-go/m","cost":1.5}
{"ts":9990000,"slot":1,"issue":1,"model":"opencode-go/m","cost":2}
{"ts":9500000,"slot":2,"issue":2,"model":"opencode-go/m","cost":4}
{"ts":8000000,"slot":2,"issue":2,"model":"opencode-go/m","cost":8}
{"ts":1000000,"slot":2,"issue":2,"model":"opencode-go/m","cost":100}
garbage
S
assert_json_eq "5 h / 7 d / 30 d windows (a partial last line is skipped)" '{"h5":3.5,"week":7.5,"month":15.5}' "$(spend_summary)"
rm -f "$STATE/spend.jsonl"
assert_json_eq "no ledger: zeros" '{"h5":0,"week":0,"month":0}' "$(spend_summary)"
cat > "$STATE/spend.jsonl" <<'S'
{"ts":9990000,"cost":9}
{"ts":9999000,"cost":6}
S
assert_eq "under every budget: 0" 0 "$(GO_BUDGET_5H=20 spend_blocked_until)"
assert_eq "5 h budget 14: the 9 leaves the window at ts+5h, which brings it under" "$((9990000 + 18000))" "$(spend_blocked_until)"
assert_eq "budget 0 switches Go off for an hour" "$((10000000 + 3600))" "$(GO_BUDGET_5H=0 spend_blocked_until)"

echo "the week is OpenCode's: since Monday 00:00 UTC, not a trailing 7 d"
assert_eq "go_week_start of a Wednesday (2026-10-21 23:40Z)" 1792368000 "$(NOW=1792626000 go_week_start)"
assert_eq "...and of that Monday 00:00Z itself" 1792368000 "$(NOW=1792368000 go_week_start)"
# NOW=10000000: the week started at 9417600 and the next one starts at 10022400.
cat > "$STATE/spend.jsonl" <<'S'
{"ts":9417599,"cost":50}
{"ts":9417600,"cost":4}
{"ts":9999000,"cost":2}
S
assert_json_eq "a row from last week is in the trailing 30 d but not in the week" '{"h5":2,"week":6,"month":56}' "$(spend_summary)"
assert_eq "last week's 50 does not block this week" 0 "$(GO_BUDGET_5H=100 GO_BUDGET_WEEK=36 GO_BUDGET_MONTH=1000 spend_blocked_until)"
assert_eq "at the week budget: blocked until next Monday 00:00 UTC" 10022400 "$(GO_BUDGET_5H=100 GO_BUDGET_WEEK=6 GO_BUDGET_MONTH=1000 spend_blocked_until)"
assert_eq "week budget 0 switches Go off for an hour" "$((10000000 + 3600))" "$(GO_BUDGET_5H=100 GO_BUDGET_WEEK=0 GO_BUDGET_MONTH=1000 spend_blocked_until)"
finish
