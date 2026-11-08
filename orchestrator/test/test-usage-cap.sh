#!/usr/bin/env bash
# Tests for the usage_cap class (OpenCode Go weekly cap). No model is called, nothing real is touched:
# a temp STATE, a fixed NOW, the real .err line of 2026-10-25, and the watchdog/earliest_cooldown_note
# functions cut out of run.sh. usage: test-usage-cap.sh [lib.sh] [run.sh] (default: the repo's)
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LIB=${1:-$HERE/lib.sh}
RUN=${2:-$HERE/run.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export STATE=$T/state LOCKS=$T/locks UI=$T/ui
mkdir -p "$STATE" "$LOCKS" "$UI"
# shellcheck disable=SC1090
source "$LIB"
eval "$(sed -n '/^watchdog_init()/,/^}/p;/^unit_cpu_ns()/p;/^watchdog_poll()/,/^}/p;/^earliest_cooldown_note()/,/^}/p' "$RUN")"
unit_cpu_ns() { echo 0; }
RATE_LIMIT_GRACE=20 IDLE_TIMEOUT=900
M=opencode-go/deepseek-v4.1-flash
pass=0 fail=0
ok() { pass=$((pass+1)); printf 'PASS  %s\n' "$1"; }
no() { fail=$((fail+1)); printf 'FAIL  %s (got: %s)\n' "$1" "$2"; }
eq() { if [[ $2 == "$3" ]]; then ok "$1 = $3"; else no "$1 (want $3)" "$2"; fi; }

REAL='timestamp=2026-10-25T20:13:30.259Z level=ERROR run=dcc1fab4 message="stream error" providerID=opencode-go modelID=deepseek-v4.1-flash session.id=ses_e8b4 small=false agent=build mode=primary error.error="AI_APICallError: Go usage limit exceeded"'
printf '%s\n' "$REAL" > "$T/usage.err"
printf '%s\n' 'timestamp=2026-10-20T10:00:00Z level=ERROR message="stream error" error.error="AI_APICallError: Rate limit exceeded. Please retry"' > "$T/rl.err"
printf '%s\n' 'timestamp=2026-10-20T10:00:00Z level=ERROR message="stream error" error.error="APIError statusCode: 429 too many requests"' > "$T/429.err"
printf '%s\n' 'timestamp=2026-10-20T10:00:00Z level=ERROR message="stream error" error.error="AI_APICallError: free usage limit reached"' > "$T/free.err"
printf '%s\n' 'timestamp=2026-10-20T10:00:00Z level=WARN message="webfetch result" text="this page mentions a usage limit exceeded notice"' > "$T/toolnoise.err"
printf '%s\n' 'timestamp=2026-10-20T10:00:00Z level=ERROR message="tool failed" error="the usage limit exceeded text of some page"' > "$T/toolerr.err"
printf '%s\n' 'timestamp=2026-10-20T10:00:00Z level=WARN message="something slow"' > "$T/stall.err"

epoch() { date -u -d "$1" +%s; }
echo "== (a) real Go usage-cap line"
eq "err_log_class(real .err)" "$(err_log_class "$T/usage.err" 0)" usage_cap
eq "matched line is the real one" "$(err_log_usage_cap_line "$T/usage.err" 0 | grep -o 'Go usage limit exceeded')" "Go usage limit exceeded"
for NOWS in "2026-10-25T20:13:30Z:2026-10-26T00:00:00Z" "2026-10-26T00:00:00Z:2026-11-02T00:00:00Z" "2026-10-30T12:00:00Z:2026-11-02T00:00:00Z" "2026-10-26T23:59:59Z:2026-11-02T00:00:00Z"; do
  n=${NOWS%%Z:*}Z; want=${NOWS#*Z:}
  export NOW=$(epoch "$n"); rm -f "$(cooldown_file "$M")"
  cooldown_hit "$M" usage_cap
  eq "cooldown_until after usage_cap at $n" "$(date -u -d "@$(cooldown_until "$M")" +%FT%TZ)" "$want"
  eq "  weekday of until" "$(date -u -d "@$(cooldown_until "$M")" +%a)" Mon
done
export NOW=$(epoch 2026-10-25T20:13:30Z); rm -f "$(cooldown_file "$M")"; cooldown_hit "$M" usage_cap
eq "cooldown file: reason word" "$(cooldown_reason "$M")" usage_cap
eq "is_cooling right after" "$(is_cooling "$M" && echo yes || echo no)" yes
eq "cooldown_json reason" "$(cooldown_json "$M" | jq -r --arg m "$M" '.[$m].reason')" usage_cap
EFF_MODELS=("$M")
echo "console note: $(earliest_cooldown_note)"
eq "note names Go cap and Monday" "$(earliest_cooldown_note | grep -c 'weekly OpenCode Go quota used up.*Monday 00:00Z')" 1
eq "note has the return date" "$(earliest_cooldown_note | grep -c 'Mon 2026-10-26 00:00Z')" 1
export NOW=$(epoch 2026-10-26T00:00:01Z)
eq "is_cooling after Monday 00:00:01Z" "$(is_cooling "$M" && echo yes || echo no)" no
echo "-- manual lift"
export NOW=$(epoch 2026-10-25T20:13:30Z); rm -f "$(cooldown_file "$M")"; cooldown_hit "$M" usage_cap
rm "$(cooldown_file "$M")"
eq "after rm of the cooldown file, is_cooling" "$(is_cooling "$M" && echo yes || echo no)" no

echo "== jsonl error event path (err_class)"
J=$T/e.jsonl
echo '{"type":"error","error":{"name":"APIError","data":{"message":"Go usage limit exceeded","statusCode":429}}}' > "$J"
eq "err_class usage event (even with 429)" "$(err_class "$J")" usage_cap
echo '{"type":"error","error":{"name":"APIError","data":{"message":"Rate limit exceeded","statusCode":429}}}' > "$J"
eq "err_class 429 rate limit" "$(err_class "$J")" rate_limit
echo '{"type":"error","error":{"name":"APIError","data":{"message":"boom"}}}' > "$J"
eq "err_class other" "$(err_class "$J")" other
echo '{"type":"text"}' > "$J"
eq "err_class none" "$(err_class "$J")" none

echo "== (b) rate limit unchanged"
eq "err_log_class rate limit line" "$(err_log_class "$T/rl.err" 0)" rate_limit
eq "err_log_class 429 line" "$(err_log_class "$T/429.err" 0)" rate_limit
eq "err_log_class 'free usage limit' (old message)" "$(err_log_class "$T/free.err" 0)" rate_limit
export NOW=1000000
eq "cooldown_next rate_limit k=0" "$(cooldown_next rate_limit 0 $NOW)" "1000600 1"
eq "cooldown_next rate_limit k=1" "$(cooldown_next rate_limit 1 $NOW)" "1001200 2"
eq "cooldown_next rate_limit cap 2h" "$(cooldown_next rate_limit 9 $NOW)" "1007200 10"
eq "cooldown_next stalled k=0 (other: 20 min)" "$(cooldown_next stalled 0 $NOW)" "1001200 1"
eq "cooldown_next other cap 6h" "$(cooldown_next other 9 $NOW)" "1021600 10"
rm -f "$(cooldown_file "$M")"; cooldown_hit "$M" rate_limit
eq "rate_limit cooldown_reason" "$(cooldown_reason "$M")" rate_limit
eq "rate_limit until = now+600" "$(cooldown_until "$M")" 1000600

echo "== false positives do not become usage_cap"
eq "WARN line with the phrase" "$(err_log_class "$T/toolnoise.err" 0)" none
eq "ERROR line not from the API client" "$(err_log_class "$T/toolerr.err" 0)" none

echo "== watchdog"
wd() {  # wd <err-file> <seconds-after-start-to-poll...>: prints the last WD_RESULT
  : > "$T/ev.jsonl"; ISB_EVENTS=$T/ev.jsonl ISB_ERR=$1; shift
  local t0=1000000 s r=""
  NOW=$t0 watchdog_init
  for s in "$@"; do NOW=$((t0 + s)); watchdog_poll u; r=$WD_RESULT; done
  echo "${r:-empty}"
}
eq "usage-cap line: first poll (inside grace)" "$(wd "$T/usage.err" 0)" empty
eq "usage-cap line: after 25 s -> usage_cap (not a 15 min stall)" "$(wd "$T/usage.err" 0 25)" usage_cap
eq "rate-limit line: after 25 s" "$(wd "$T/rl.err" 0 25)" rate_limit
eq "429 line: after 25 s" "$(wd "$T/429.err" 0 25)" rate_limit
eq "no message, 899 s" "$(wd "$T/stall.err" 0 899)" empty
eq "no message, 901 s -> stalled" "$(wd "$T/stall.err" 0 901)" stalled
eq "phrase only in a WARN line, 901 s -> stalled (not usage_cap)" "$(wd "$T/toolnoise.err" 0 901)" stalled
cat "$T/rl.err" "$T/usage.err" > "$T/both.err"
eq "both in the log -> usage_cap wins" "$(wd "$T/both.err" 0 25)" usage_cap

echo; echo "passed=$pass failed=$fail"
[[ $fail == 0 ]]
