#!/usr/bin/env bash
# The turn watchdog (silent rate limit, idle stall) and the money guard (Go ledger, budgets,
# cost > 0 on a free model), with the fake sandbox and systemctl.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u

export FAKE_LOG=$T/fake.log FAKE_SYSTEMCTL_LOG=$T/systemctl.log FAKE_KILL_DIR=$T/killed
export SANDBOX=$TESTDIR/bin/fake-sandbox.sh PROMPTS=$ORCH/prompts GH_TOKEN_FILE=$T/token
RATE_LIMIT_GRACE=1 IDLE_TIMEOUT=3
K=1 RUN_ID=run-AAA SLOTDIR=$H/s1 WORK=$H/s1/work OUT=$H/s1/out
mkdir -p "$WORK" "$STATE/claims" "$STATE/locks" "$STATE/cooldown"
run=$T/log/issue-5-x-s1; mkdir -p "$run"
ST_RUN=$RUN_ID n=5 base=deadbeef
reset() {
  rm -f "$FAKE_LOG" "$FAKE_SYSTEMCTL_LOG" "$UI/stats.jsonl" "$UI/halt.json" "$STATE/cooldown/"* "$STATE/claims/"* "$STATE/spend.jsonl" "$CTL/interrupt-1.json"
  : > "$FAKE_LOG"; : > "$FAKE_SYSTEMCTL_LOG"
  STOP_PENDING=0 NOINT=0 LAST_INTR_ID="" INTR_SIG="" STEER_MSG="" STEER_ID="" STEER_TAKEN="" STEER_QUOTES=()
  ST_STATE=running ST_STAGE="" ST_SUB="" ST_NOTE="" ST_RUN=$RUN_ID
  CUR_STAGE="" sid="" impl_model="" pr="" used=() ISB_KIND=turn
  unset FAKE_MODE FAKE_RC
  export FAKE_SLEEP=60  # a watchdog turn ends when the watchdog kills it; 60 s only if it never does
}
stats_has() { jq -e -s "$1" "$UI/stats.jsonl" >/dev/null 2>&1; }
put_models() {  # put_models <control-models-json> <models.json>
  printf '%s\n' "$2" > "$UI/models.json"
  printf '{"v":1,"agents":1,"models":%s,"model_mode":"ordered","paused":false,"queue":[],"skip":[],"resume_ack":null}\n' "$1" > "$CTL/control.json"
}
TWO='{"v":1,"free":[{"id":"opencode/a-free","zero_retention":true},{"id":"opencode/b-free","zero_retention":true}]}'

echo "watchdog: a rate limit only in opencode's log"
reset; put_models '["opencode/a-free","opencode/b-free"]' "$TWO"
export FAKE_MODE=wd_rl
# The stall timer must not win this race on a slow poll: here only the rate limit may fire.
( IDLE_TIMEOUT=60; agent build 60 "PESAN-ASLI"; echo "sid=$sid last=$last_model" > "$T/res" ) >/dev/null 2>&1
assert_eq "the next model finished the turn, same session" "sid=ses_fake1 last=opencode/b-free" "$(cat "$T/res" 2>/dev/null)"
assert_true "opencode is asked for its log on stderr" grep -q -- '--print-logs --log-level WARN' "$FAKE_LOG"
second=$(grep 'cmd=opencode' "$FAKE_LOG" | tail -n1)
assert_true "resumed with -s <sid> on the next model" bash -c "grep -q -- '-s ses_fake1' <<<'$second' && grep -q -- '-m opencode/b-free' <<<'$second'"
assert_true "the resume message repeats the phase contract, not the whole prompt" bash -c "grep -q 'The previous turn was cut off' <<<'$second' && ! grep -q PESAN-ASLI <<<'$second'"
assert_eq "the limited model is cooling: rate_limit" rate_limit "$(awk '{print $3}' "$STATE/cooldown/opencode_a-free")"
assert_false "the second model is not cooled" test -e "$STATE/cooldown/opencode_b-free"
assert_true "stats: rate_limited call, not stalled" stats_has 'any(.[]; .kind == "call" and .model == "opencode/a-free" and .rate_limited == true and .stalled == false and .model_error == true)'
assert_false "no failure outcome, no halt" stats_has 'any(.[]; .kind == "outcome")'
assert_false "no halt" test -e "$UI/halt.json"
assert_true "the turn was ended with SIGTERM (session kept)" grep -Eq '^kill --kill-whom=main -s TERM factory-sb-1-' "$FAKE_SYSTEMCTL_LOG"

echo "watchdog: a stalled turn (no events, no CPU)"
reset; put_models '["opencode/a-free","opencode/b-free"]' "$TWO"
export FAKE_MODE=wd_stall
( agent build 60 "x"; echo "last=$last_model" > "$T/res" ) >/dev/null 2>&1
assert_eq "resumed on the next model" "last=opencode/b-free" "$(cat "$T/res" 2>/dev/null)"
assert_eq "stalled cools with the 'other' schedule" "stalled" "$(awk '{print $3}' "$STATE/cooldown/opencode_a-free")"
assert_true "stats: stalled call, not rate limited" stats_has 'any(.[]; .kind == "call" and .stalled == true and .rate_limited == false and .model_error == true)'

echo "watchdog: every model stalls -> the lane backs off, never fails the issue"
reset; put_models '["opencode/a-free","opencode/b-free"]' "$TWO"
export FAKE_MODE=wd_stall_all
( agent build 60 "x" ) >/dev/null 2>&1; rc=$?
assert_eq "agent exits 0" 0 "$rc"
assert_eq "state backoff" backoff "$(jq -r .state "$UI/slots/1.json")"
assert_true "outcome retry only" stats_has '[.[] | select(.kind == "outcome")] | map(.outcome) == ["retry"]'
assert_false "no label, no PR closed" grep -q 'issue edit\|pr close' "$FAKE_LOG"

echo "watchdog_poll: CPU counts as life, a recovered retry is not a limit"
IDLE_TIMEOUT=100
cpu_unit() { echo "${FAKE_CPU_NS:-}"; }
(
  ISB_EVENTS=$T/ev ISB_ERR=$T/er; : > "$ISB_EVENTS"; : > "$ISB_ERR"
  unit_cpu_ns() { cpu_unit; }
  NOW=1000; watchdog_init
  FAKE_CPU_NS=1000000000; NOW=1031; watchdog_poll x; a=$WD_RESULT
  FAKE_CPU_NS=6000000000; NOW=1062; watchdog_poll x; b=$WD_RESULT
  FAKE_CPU_NS=11000000000; NOW=1093; watchdog_poll x; c=$WD_RESULT
  FAKE_CPU_NS=11000000100; NOW=1094; watchdog_poll x
  NOW=2000; watchdog_poll x; d=$WD_RESULT
  echo "$a|$b|$c|$d" > "$T/cpu.res"
)
assert_eq "a busy unit never stalls; a flat one does after IDLE_TIMEOUT" "|||stalled" "$(cat "$T/cpu.res")"
(
  ISB_EVENTS=$T/ev2 ISB_ERR=$T/er2; : > "$ISB_EVENTS"; echo 'level=ERROR Rate limit exceeded' > "$ISB_ERR"
  unit_cpu_ns() { echo ""; }
  NOW=5000; watchdog_init; watchdog_poll x; a=$WD_RESULT
  echo '{"type":"text"}' >> "$ISB_EVENTS"; NOW=5003; watchdog_poll x; b=$WD_RESULT
  NOW=5010; watchdog_poll x; c=$WD_RESULT
  echo "$a|$b|$c" > "$T/rl.res"
)
assert_eq "recovered: nothing fires" "||" "$(cat "$T/rl.res")"
IDLE_TIMEOUT=3
echo 'failed to generate; port 14290' > "$T/e3"
assert_false "'generate' and a port number are not rate limits" err_log_rate_limited "$T/e3"
echo 'statusCode=429 upstream' > "$T/e4"
assert_true "429 as a status is" err_log_rate_limited "$T/e4"
printf 'Rate limit exceeded\nok line\n' > "$T/e5"
assert_false "the byte offset skips what was already forgiven" err_log_rate_limited "$T/e5" 21

echo "money guard: Go may cost, anyone else halts"
reset
GO='{"v":1,"free":[{"id":"opencode/a-free","zero_retention":true}],"paid":[{"id":"opencode-go/m1","zero_retention":true}]}'
put_models '["opencode-go/m1","opencode/a-free"]' "$GO"
export FAKE_MODE=go_cost NOW=1792130000
( agent build 60 "x"; echo "last=$last_model" > "$T/res" ) >/dev/null 2>&1
assert_eq "the Go turn completed (no halt)" "last=opencode-go/m1" "$(cat "$T/res")"
assert_false "no halt.json" test -e "$UI/halt.json"
assert_eq "ledger: one line with ts/slot/issue/model/cost" '{"ts":1792130000,"slot":1,"issue":5,"model":"opencode-go/m1","cost":0.25}' "$(jq -c . "$STATE/spend.jsonl")"
assert_true "stats: the call carries the cost" stats_has 'any(.[]; .kind == "call" and .cost == 0.25)'
assert_json_eq "spend_summary" '{"h5":0.25,"week":0.25,"month":0.25}' "$(spend_summary)"
reset
put_models '["opencode/a-free"]' "$GO"
export FAKE_MODE=cost
( agent build 60 "x" ) >/dev/null 2>&1
assert_true "cost > 0 on a free model still halts" bash -c "jq -r .id '$UI/halt.json' | grep -Eq '^[0-9]+-cost$'"
assert_false "and nothing goes to the Go ledger" test -s "$STATE/spend.jsonl"

echo "budget: over the 5 h budget the Go model cools and the free one takes the turn"
reset
put_models '["opencode-go/m1","opencode/a-free"]' "$GO"
export FAKE_MODE=ok NOW=1792130000
printf '%s\n' '{"ts":1792128000,"slot":1,"issue":4,"model":"opencode-go/m1","cost":9}' '{"ts":1792129000,"slot":2,"issue":6,"model":"opencode-go/m1","cost":5.5}' > "$STATE/spend.jsonl"
( agent build 60 "x"; echo "last=$last_model" > "$T/res" ) >/dev/null 2>&1
assert_eq "the free model ran" "last=opencode/a-free" "$(cat "$T/res")"
assert_false "the Go model was never called" grep -q 'opencode-go/m1' "$FAKE_LOG"
assert_eq "cooling until the oldest turn leaves the window, reason budget" "1792146000 0 budget" "$(cat "$STATE/cooldown/opencode-go_m1")"
export NOW=1792146500
models_refresh
assert_false "window freed: the budget cooldown is lifted" test -e "$STATE/cooldown/opencode-go_m1"
assert_eq "...and Go is first again" "opencode-go/m1" "${EFF_MODELS[0]}"
finish
