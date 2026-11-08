#!/usr/bin/env bash
# The interruptible sandbox call and the model-turn loop, with a fake sandbox and systemctl:
# stop, steer (mid-turn, in verify, deferred), run_id/id matching, resume, fallbacks, cooldown
# and the cost tripwire.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u

export FAKE_LOG=$T/fake.log FAKE_SYSTEMCTL_LOG=$T/systemctl.log
export SANDBOX=$TESTDIR/bin/fake-sandbox.sh PROMPTS=$ORCH/prompts GH_TOKEN_FILE=$T/token
K=1 RUN_ID=run-AAA SLOTDIR=$H/s1 WORK=$H/s1/work OUT=$H/s1/out
mkdir -p "$WORK" "$STATE/claims" "$STATE/locks" "$STATE/cooldown"
run=$T/log/issue-5-x-s1; mkdir -p "$run"
ST_RUN=$RUN_ID n=5 base=deadbeef
IF=$CTL/interrupt-1.json
put_intr() {  # put_intr <id> <run_id> <action> [message] [skip]
  jq -nc --arg id "$1" --arg r "$2" --arg a "$3" --arg m "${4:-}" --argjson s "${5:-false}" \
    '{v:1,id:$id,run_id:$r,action:$a,skip:$s,message:$m,at:"2026-10-16T06:30:00Z"}' > "$IF"
}
reset() {
  rm -f "$IF" "$FAKE_LOG" "$FAKE_SYSTEMCTL_LOG" "$UI/stats.jsonl" "$UI/halt.json" "$STATE/cooldown/"* "$STATE/claims/"*
  : > "$FAKE_LOG"; : > "$FAKE_SYSTEMCTL_LOG"
  STOP_PENDING=0 STOP_ID="" STOP_SKIP=false NOINT=0 LAST_INTR_ID="" INTR_SIG="" STEER_MSG="" STEER_ID="" STEER_TAKEN="" STEER_QUOTES=()
  ST_STATE=running ST_STAGE="" ST_SUB="" ST_NOTE="" ST_STEER_PENDING=null ST_STEER_LAST=null ST_INTR_JSON=null ST_RUN=$RUN_ID
  CUR_STAGE="" sid="" impl_model="" pr="" used=() ISB_KIND=turn
  unset FAKE_MODE FAKE_RC
  export FAKE_SLEEP=3
}
stats_has() { jq -e -s "$1" "$UI/stats.jsonl" >/dev/null 2>&1; }

echo "isb basics"
reset
isb 60 sleepy > /dev/null; rc=$?
assert_eq "no interrupt: returns the command's code (0)" 0 "$rc"
assert_true "unit is named factory-sb-<K>-<epoch>-<rand>" grep -Eq 'unit=factory-sb-1-[0-9]+-[0-9]+ ' "$FAKE_LOG"
export FAKE_RC=7; isb 60 sleepy > /dev/null; rc=$?
assert_eq "command code 7 comes back" 7 "$rc"

echo "isb hands AGENT_CRED to the sandbox only while its file exists"
reset; unset FAKE_RC; export FAKE_SLEEP=0 FAKE_CRED_LOG=$T/cred.log; : > "$FAKE_CRED_LOG"
AGENT_CRED=cds:$T/cds.key
isb 60 sleepy > /dev/null
echo key > "$T/cds.key"
isb 60 sleepy > /dev/null
assert_eq "no file: no SB_CRED; file: SB_CRED=<name>:<path>" "|cds:$T/cds.key" "$(paste -sd'|' "$FAKE_CRED_LOG")"
rm -f "$T/cds.key"; unset FAKE_CRED_LOG; AGENT_CRED=""

echo "stop"
reset
claim_take 5 >/dev/null; CUR_STAGE=build
put_intr s1 "$RUN_ID" stop
out=$( ( isb 60 sleepy; echo NOTREACHED ) 2>&1 ); rc=$?
assert_eq "stop: exits 0 from inside the wrapper" 0 "$rc"
assert_false "stop: nothing after isb ever runs (no agent-failed path)" grep -q NOTREACHED <<<"$out"
assert_true "stop: the slice is stopped, not the client" grep -q '^stop factory-s1.slice' "$FAKE_SYSTEMCTL_LOG"
assert_true "stop: outcome stopped recorded" stats_has 'any(.[]; .kind == "outcome" and .outcome == "stopped" and .slot == 1)'
assert_true "stop: stage result stopped" stats_has 'any(.[]; .kind == "stage" and .stage == "build" and .result == "stopped")'
assert_false "stop: never agent-failed / verify_failed" stats_has 'any(.[]; .kind == "outcome" and (.outcome == "verify_failed" or .outcome == "retry"))'
assert_eq "stop: slot status stopped" stopped "$(jq -r .state "$UI/slots/1.json")"
assert_eq "stop: interrupt.last_id reported" s1 "$(jq -r .interrupt.last_id "$UI/slots/1.json")"
assert_false "stop: claim released" test -e "$STATE/claims/5"

reset
put_intr s2 "$RUN_ID" stop "" true
( ISB_KIND=verify isb 60 sleepy; echo NOTREACHED ) >/dev/null 2>&1
assert_eq "stop during verify stops too; skip noted" "stopped|stopped from the console (skip)" "$(jq -r '[.state,.note]|join("|")' "$UI/slots/1.json")"
assert_false "stop during verify: no failure outcome" stats_has 'any(.[]; .kind == "outcome" and .outcome != "stopped")'

echo "interrupt validity"
reset
put_intr s3 other-run stop
isb 60 sleepy >/dev/null; rc=$?
assert_eq "stale run_id: ignored, call completes" 0 "$rc"
assert_eq "stale run_id: nothing pending" 0 "$STOP_PENDING"
reset
LAST_INTR_ID=s4
put_intr s4 "$RUN_ID" stop
isb 60 sleepy >/dev/null; rc=$?
assert_eq "already-handled id: ignored" "0 0" "$rc $STOP_PENDING"
reset
echo 'not json' > "$IF"
isb 60 sleepy >/dev/null; rc=$?
assert_eq "invalid file: ignored" "0 0" "$rc $STOP_PENDING"
assert_true "root never touched the file" test -s "$IF"

echo "steer mid-turn"
reset
put_intr e1 "$RUN_ID" steer "Pakai ADR-0012"
ISB_KIND=turn isb 60 sleepy >/dev/null; rc=$?
assert_eq "steer during a turn: 75" 75 "$rc"
assert_eq "steer is pending" "Pakai ADR-0012" "$STEER_MSG"
assert_true "soft kill: SIGTERM to the unit's main process" grep -Eq '^kill --kill-whom=main -s TERM factory-sb-1-' "$FAKE_SYSTEMCTL_LOG"
assert_eq "pending shown in the status" e1 "$(jq -r .steer.pending.id "$UI/slots/1.json")"

reset
put_intr e2 "$RUN_ID" steer "Pakai ADR-0012"
ISB_KIND=verify isb 60 sleepy >/dev/null; rc=$?
assert_eq "steer during verify: verify finishes (0)" 0 "$rc"
assert_eq "steer during verify: still pending" "Pakai ADR-0012" "$STEER_MSG"
assert_false "steer during verify: no kill" grep -q 'kill' "$FAKE_SYSTEMCTL_LOG"

echo "stop deferred inside merge + deploy"
reset
NOINT=1
put_intr d1 "$RUN_ID" stop
isb 60 sleepy >/dev/null; rc=$?
assert_eq "NOINT: the call completes" 0 "$rc"
assert_eq "NOINT: stop stays pending" 1 "$STOP_PENDING"
assert_eq "NOINT: sub says stop deferred" "stop deferred" "$(jq -r .sub "$UI/slots/1.json")"
stage deploy
assert_eq "a stage change keeps the deferred marker" "stop deferred" "$ST_SUB"
NOINT=0
( gate_stop; echo NOTREACHED ) >/dev/null 2>&1; rc=$?
assert_eq "after the section the stop applies (exit 0)" 0 "$rc"
assert_true "...and is recorded as stopped" stats_has 'any(.[]; .kind == "outcome" and .outcome == "stopped")'

echo "agent(): steer mid-turn resumes the same session"
printf '%s\n' '{"v":1,"free":[{"id":"opencode/a-free"}]}' > "$UI/models.json"
printf '%s\n' '{"v":1,"agents":1,"models":["opencode/a-free"],"model_mode":"ordered","paused":false,"queue":[],"skip":[],"resume_ack":null}' > "$CTL/control.json"
reset
export FAKE_MODE=steer_sid FAKE_SLEEP=5
( sleep 1.5; put_intr m1 "$RUN_ID" steer "Use the shipping presets" ) &
( agent build 60 "ORIGINAL-MESSAGE"; echo "sid=$sid steered=$STEER_TAKEN last=$last_model quotes=${#STEER_QUOTES[@]}" > "$T/res" ) >/dev/null 2>&1
wait
assert_eq "agent returned with the session id and the steer recorded" "sid=ses_fake1 steered=Use the shipping presets last=opencode/a-free quotes=1" "$(cat "$T/res")"
assert_eq "two opencode runs" 2 "$(grep -c 'cmd=opencode' "$FAKE_LOG")"
second=$(grep 'cmd=opencode' "$FAKE_LOG" | tail -n1)
assert_true "resumed with -s <sid>" grep -q -- '-s ses_fake1' <<<"$second"
assert_true "resume message carries the steer" grep -q 'Steer from a human: Use the shipping presets' <<<"$second"
assert_true "resume message repeats the build output contract (commit + checklist)" grep -q 'agent-checklist.json' <<<"$second"
assert_true "index.lock removed before resuming" grep -q 'rm -f .git/index.lock' "$FAKE_LOG"
assert_true "stats: the cut turn is a call with rc 75" stats_has 'any(.[]; .kind == "call" and .rc == 75)'
assert_true "stats: the steer is recorded applied" stats_has 'any(.[]; .kind == "steer" and .outcome == "applied")'
assert_eq "slot status: steer.last applied" applied "$(jq -r .steer.last.outcome "$UI/slots/1.json")"

echo "agent(): the plan contract survives a steer"
reset
export FAKE_MODE=steer_sid FAKE_SLEEP=5
( sleep 1.5; put_intr m2 "$RUN_ID" steer "Mind the time zone" ) &
( agent plan 60 "PESAN-PLAN" ) >/dev/null 2>&1
wait
second=$(grep 'cmd=opencode' "$FAKE_LOG" | tail -n1)
assert_true "plan steer repeats the json-block requirement" grep -q 'end your answer with one ```json block' <<<"${second,,}"
assert_false "plan steer does not tell the planner to commit" grep -q 'commit every change' <<<"$second"

echo "agent(): no session id yet -> restart the turn with the message prepended"
reset
export FAKE_MODE=steer_nosid FAKE_SLEEP=5
( sleep 1.5; put_intr m3 "$RUN_ID" steer "Start from the engine" ) &
( agent plan 60 "ORIGINAL-MESSAGE"; echo "sid=$sid" > "$T/res" ) >/dev/null 2>&1
wait
second=$(grep 'cmd=opencode' "$FAKE_LOG" | tail -n1)
assert_false "restart is a new session (no -s)" grep -q -- ' -s ' <<<"$second"
assert_true "restart message = steer + the original message" grep -q 'Steer from a human: Start from the engine.*ORIGINAL-MESSAGE' <<<"$second"
assert_eq "session id found in the new run" sid=ses_fake1 "$(cat "$T/res")"

echo "agent(): the resumed session errors -> fresh session with the steer and the working tree"
reset
export FAKE_MODE=steer_resume_err FAKE_SLEEP=5
issue_text="ISSUE-TEXT"
( sleep 1.5; put_intr m4 "$RUN_ID" steer "Change the approach" ) &
( agent build 60 "ORIGINAL-MESSAGE"; echo "sid=$sid" > "$T/res" ) >/dev/null 2>&1
wait
third=$(grep 'cmd=opencode' "$FAKE_LOG" | tail -n1)
assert_eq "three runs: cut, failed resume, fresh" 3 "$(grep -c 'cmd=opencode' "$FAKE_LOG")"
assert_false "fresh session has no -s" grep -q -- ' -s ' <<<"$third"
assert_true "fresh message: issue text, steer, 'carry on from the working tree'" bash -c "grep -q 'ISSUE-TEXT' <<<'$third' && grep -q 'Change the approach' <<<'$third' && grep -q 'Carry on from the working tree as it is' <<<'$third'"
assert_eq "agent still succeeded" sid=ses_fake1 "$(cat "$T/res")"
assert_false "a failed resume did not cool the model (the fresh run decides)" test -e "$STATE/cooldown/opencode_a-free"

echo "agent(): a steer already pending is prepended to the next turn"
reset
export FAKE_MODE=ok
put_intr m5 "$RUN_ID" steer "Steer before the turn"
( agent build 60 "ORIGINAL-MESSAGE" ) >/dev/null 2>&1
assert_true "prepended: 'Steer from a human: <message>' then the phase message" grep -q 'Steer from a human: Steer before the turn' "$FAKE_LOG"
assert_eq "one run only" 1 "$(grep -c 'cmd=opencode' "$FAKE_LOG")"

echo "agent(): rate limit cools the model; with no other model the lane backs off"
reset
export FAKE_MODE=rate
( agent build 60 "x" ) >/dev/null 2>&1; rc=$?
assert_eq "agent exits 0 (lane_exit backoff)" 0 "$rc"
assert_eq "cooldown: 10 min, k 1, reason rate_limit" "rate_limit" "$(awk '{print $3}' "$STATE/cooldown/opencode_a-free")"
assert_eq "status: backoff" backoff "$(jq -r .state "$UI/slots/1.json")"
assert_true "status note says until when" bash -c "jq -r .note '$UI/slots/1.json' | grep -q 'until'"
assert_true "stats: rate_limited call" stats_has 'any(.[]; .kind == "call" and .rate_limited == true and .model_error == true)'
( agent build 60 "x" ) >/dev/null 2>&1
assert_eq "second time: every model is cooling, no new call" 1 "$(grep -c 'cmd=opencode' "$FAKE_LOG")"
assert_eq "...and it says so" "backoff" "$(jq -r .state "$UI/slots/1.json")"

echo "gate_cooldown: at pick, every model cooling backs off and says until when"
reset; rm -f "$T/res"
EFF_MODELS=(opencode/a-free)
( gate_cooldown; echo past > "$T/res" ) >/dev/null 2>&1
assert_eq "nothing cooling: the lane goes on" past "$(cat "$T/res" 2>/dev/null)"
printf '%s 1 other\n' "$(( $(now) + 1200 ))" > "$STATE/cooldown/opencode_a-free"
rm -f "$T/res"
( gate_cooldown; echo past > "$T/res" ) >/dev/null 2>&1
assert_false "every model cooling: the lane stops there" test -e "$T/res"
assert_eq "status: backoff" backoff "$(jq -r .state "$UI/slots/1.json")"
assert_true "status note says until when" bash -c "jq -r .note '$UI/slots/1.json' | grep -q 'cooling down until [0-9][0-9]:[0-9][0-9]Z'"

echo "agent(): cost > 0 halts every lane"
reset
export FAKE_MODE=cost
( agent build 60 "x" ) >/dev/null 2>&1; rc=$?
assert_eq "exit 0" 0 "$rc"
assert_true "halt.json written with slug cost" bash -c "jq -r .id '$UI/halt.json' | grep -Eq '^[0-9]+-cost$'"
assert_eq "status halted" halted "$(jq -r .state "$UI/slots/1.json")"
CONTROL=$CONTROL_DEFAULT
assert_true "other lanes see it" halted
( agent build 60 "x" ) >/dev/null 2>&1
assert_eq "a halted lane starts no turn" 1 "$(grep -c 'cmd=opencode' "$FAKE_LOG")"

echo "on_exit: a steer left at the end is reported dropped; run_id cleared"
reset
STEER_MSG="never used" STEER_ID=z9
( trap on_exit EXIT; ST_STATE=running; exit 0 ) >/dev/null 2>&1
assert_true "stats: steer dropped" stats_has 'any(.[]; .kind == "steer" and .outcome == "dropped")'
assert_eq "status: dropped, run_id null, idle" "dropped|null|idle" "$(jq -r '[.steer.last.outcome, (.run_id|tostring), .state]|join("|")' "$UI/slots/1.json")"

echo "steer in the PR body"
reset
STEER_QUOTES=($'baris satu\nbaris dua')
body=$(steer_section)
assert_true "quoted verbatim, every line" bash -c "grep -q '^> baris satu' <<<'$body' && grep -q '^> baris dua' <<<'$body'"
STEER_QUOTES=()
assert_eq "no steers: nothing printed" "" "$(steer_section)"
finish
