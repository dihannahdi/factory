#!/usr/bin/env bash
# ctl/interrupt-K.json: validation, run_id/id matching, steer sanitizing.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/lib.sh"
set +e

f=$T/interrupt.json
put() { printf '%s' "$1" > "$f"; }
v() { intr_validate "$f"; }

echo "intr_validate"
j=$(intr_validate "$FIX/ctl/interrupt-1.json")
assert_eq "fixture is valid" 0 "$?"
assert_eq "fixture: normalized keys" '["action","id","message","run_id","skip"]' "$(jq -c 'keys' <<<"$j")"
assert_eq "fixture: message kept" "$(jq -r .message "$FIX/ctl/interrupt-1.json")" "$(jq -r .message <<<"$j")"
assert_true "...and it is not empty" test -n "$(jq -r .message <<<"$j")"
put '{"v":1,"id":"a1","run_id":"r1","action":"stop","skip":true,"at":"2026-10-16T06:30:00Z"}'
j=$(v)
assert_eq "stop: valid, skip true, no message" "stop|true|" "$(jq -r '[.action,.skip,.message]|join("|")' <<<"$j")"
put '{"v":1,"id":"a1","run_id":"r1","action":"stop","message":"ignored for stop"}'
assert_eq "stop: message dropped" "" "$(v | jq -r .message)"
put '{"v":1,"id":"a1","run_id":"r1","action":"restart"}'
assert_false "unknown action" v
put '{"v":1,"id":"a 1","run_id":"r1","action":"stop"}'
assert_false "id with a space" v
put '{"v":1,"id":"a1;rm","run_id":"r1","action":"stop"}'
assert_false "id with shell syntax" v
put '{"v":1,"id":"a1","run_id":"r$(id)","action":"stop"}'
assert_false "run_id with shell syntax" v
put '{"v":1,"id":"a1","run_id":"r1","action":"stop","skip":"yes"}'
assert_false "skip must be boolean" v
put '{"v":1,"id":"a1","run_id":"r1","action":"steer"}'
assert_false "steer without a message" v
put '{"v":1,"id":"a1","run_id":"r1","action":"steer","message":"   "}'
assert_false "steer with a blank message" v
put '{"v":1,"id":"a1","run_id":"r1","action":"steer","message":5}'
assert_false "message must be a string" v
put '[1,2]'
assert_false "not an object" v
put 'steer now please'
assert_false "not JSON" v
rm -f "$f"
assert_false "missing file" v
head -c 70000 /dev/zero | tr '\0' ' ' > "$f"
assert_false "over 64 KB" v

echo "steer message: sanitizing and length"
m=$(printf 'a%.0s' $(seq 1 2000))
put "$(jq -nc --arg m "$m" '{id:"a1",run_id:"r1",action:"steer",message:$m}')"
assert_eq "2000 chars accepted" 2000 "$(v | jq -r '.message | length')"
put "$(jq -nc --arg m "${m}b" '{id:"a1",run_id:"r1",action:"steer",message:$m}')"
assert_false "2001 chars refused" v
m=$(printf 'é%.0s' $(seq 1 2000))
put "$(jq -nc --arg m "$m" '{id:"a1",run_id:"r1",action:"steer",message:$m}')"
assert_eq "length counts characters, not bytes" 2000 "$(v | jq -r '.message | length')"
put '{"id":"a1","run_id":"r1","action":"steer","message":"satu\u0000dua\u0001tiga\u001b[31mmerah\u007f\nbaris\ttab\r\nlagi"}'
got=$(v | jq -r .message | tr -d '\r')
assert_eq "control chars stripped, newline and tab kept" $'satudua'"tiga[31mmerah"$'\nbaris\ttab\nlagi' "$got"
put '{"id":"a1","run_id":"r1","action":"steer","message":"\u0001\u0002"}'
assert_false "message that is only control chars" v
assert_eq "sanitize_message directly" "ab" "$(printf 'a\001b\177' | sanitize_message)"

echo "intr_should_act (run_id and id matching)"
j='{"id":"i2","run_id":"run-A","action":"steer","skip":false,"message":"x"}'
assert_true "this run, new id: act" intr_should_act "$j" run-A i1
assert_false "other run (stale file): ignore" intr_should_act "$j" run-B i1
assert_false "same id already handled: ignore" intr_should_act "$j" run-A i2
assert_true "no id handled yet" intr_should_act "$j" run-A ""
assert_false "run_id prefix is not a match" intr_should_act '{"id":"i2","run_id":"run-AB"}' run-A ""

echo "steer quoting for the PR body"
q=$(printf 'baris 1\n\nbaris 3 @tim\n' | sed 's/^/> /')
assert_eq "every line, blank ones included, is quoted" $'> baris 1\n> \n> baris 3 @tim' "$q"
finish
