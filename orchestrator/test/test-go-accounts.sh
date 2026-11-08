#!/usr/bin/env bash
# Tests for the second OpenCode Go account (virtual model id opencode-go@2/<model>). No model is
# called and no real key is read: temp STATE/UI, a fixed NOW, fake key files with fake content.
# usage: test-go-accounts.sh [lib.sh] [run.sh] [sandbox.sh] [wrapper] (default: the repo's files; the
# wrapper defaults to this repo's orchestrator/factory-opencode)
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LIB=${1:-$HERE/lib.sh}
RUN=${2:-$HERE/run.sh}
SBX=${3:-$HERE/sandbox.sh}
WRAP=${4:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/factory-opencode}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export STATE=$T/state LOCKS=$T/locks UI=$T/ui SPEND=$T/spend.jsonl STATS=$T/stats.jsonl GO_KEY_DIR=$T/keys
mkdir -p "$STATE" "$LOCKS" "$UI" "$GO_KEY_DIR"
# shellcheck disable=SC1090
source "$LIB"
eval "$(sed -n '/^earliest_cooldown_note()/,/^}/p' "$RUN")"
M1=opencode-go/deepseek-v4.1-flash
M2=opencode-go@2/deepseek-v4.1-flash
FREE=opencode/deepseek-v4.1-flash-free
pass=0 fail=0
ok() { pass=$((pass+1)); printf 'PASS  %s\n' "$1"; }
no() { fail=$((fail+1)); printf 'FAIL  %s (got: %s)\n' "$1" "$2"; }
eq() { if [[ $2 == "$3" ]]; then ok "$1 = $3"; else no "$1 (want $3)" "$2"; fi; }
epoch() { date -u -d "$1" +%s; }

echo "== ids: is_go_model / valid_model / go_account / go_real_model"
for m in "$M1" "$M2" opencode-go@3/x; do eq "is_go_model $m" "$(is_go_model "$m" && echo yes || echo no)" yes; done
for m in "$FREE" opencode-go-2/deepseek opencode/x@2 opencode-gox/y "opencode-go@/x"; do eq "is_go_model $m (must be FREE class)" "$(is_go_model "$m" && echo yes || echo no)" no; done
for m in "$M1" "$M2" "$FREE"; do eq "valid_model $m" "$(valid_model "$m" && echo yes || echo no)" yes; done
eq "valid_model opencode-go@/x" "$(valid_model 'opencode-go@/x' && echo yes || echo no)" no
eq "valid_model opencode-go@2/X (uppercase)" "$(valid_model 'opencode-go@2/X' && echo yes || echo no)" no
eq "go_account account 1" "$(go_account "$M1")" 1
eq "go_account account 2" "$(go_account "$M2")" 2
eq "go_account free model" "$(go_account "$FREE")" 1
eq "go_real_model account 1" "$(go_real_model "$M1")" opencode-go/deepseek-v4.1-flash
eq "go_real_model account 2 -> real provider id" "$(go_real_model "$M2")" opencode-go/deepseek-v4.1-flash
eq "go_real_model free" "$(go_real_model "$FREE")" "$FREE"
eq "cooldown files differ per account" "$([[ $(cooldown_file "$M1") != "$(cooldown_file "$M2")" ]] && echo yes || echo no)" yes
echo "-- control.json validation (CONTROL_JQ)"
ctl() { jq -c "$CONTROL_JQ" <<<"$1" 2>&1 | head -c 200; }
eq "control.models [acct1, acct2] accepted" "$(ctl '{"v":1,"models":["opencode-go/deepseek-v4.1-flash","opencode-go@2/deepseek-v4.1-flash"]}' | jq -c .models)" '["opencode-go/deepseek-v4.1-flash","opencode-go@2/deepseek-v4.1-flash"]'
eq "control.models junk rejected" "$(ctl '{"v":1,"models":["opencode-go@x/a"]}' | grep -c models)" 1

echo "== credential handed to a turn unit"
eq "acct 1 turn: no extra credential" "$(go_credential "$M1")" ""
eq "free turn: no extra credential" "$(go_credential "$FREE")" ""
eq "acct 2 turn, key file absent: none" "$(go_credential "$M2")" ""
printf 'FAKE-KEY-CONTENT-FOR-TESTS-0000000' > "$GO_KEY_DIR/opencode2.key"
eq "acct 2 turn, key present: go2:<path> (path only)" "$(go_credential "$M2")" "go2:$GO_KEY_DIR/opencode2.key"
eq "output never contains the key text" "$(go_credential "$M2" | grep -c FAKE-KEY)" 0

echo "== spend per account"
export NOW=$(epoch 2026-10-28T12:00:00Z)   # a Wednesday; week started Mon 2026-10-26 00:00Z
row() { printf '{"ts":%s,"slot":1,"issue":1,"model":"%s","cost":%s}\n' "$1" "$2" "$3" >> "$SPEND"; }
H=$(epoch 2026-10-28T11:00:00Z)
row "$H" "$M1" 10; row "$H" "$M1" 5; row "$H" "$M2" 2
printf '{"ts":%s,"slot":1,"issue":1,"model":"opencode-go/old","cost":1}\n' "$(epoch 2026-10-20T00:00:00Z)" >> "$SPEND"
eq "spend_summary acct 1 h5" "$(spend_summary 1 | jq .h5)" 15
eq "spend_summary acct 2 h5" "$(spend_summary 2 | jq .h5)" 2
eq "spend_summary default = acct 1" "$(spend_summary | jq .h5)" 15
eq "spend_summary acct 1 month (includes the 20 Oct legacy row)" "$(spend_summary 1 | jq .month)" 16
eq "spend_accounts: acct2 week" "$(spend_accounts | jq '.["2"].week')" 2
eq "spend_accounts: acct1 budget h5 = 14 (unchanged)" "$(spend_accounts | jq '.["1"].budget.h5')" 14
eq "spend_accounts: acct2 budget h5 defaults to 14" "$(spend_accounts | jq '.["2"].budget.h5')" 14
eq "acct 1 over its 5h budget (15 > 14): blocked until H+5h" "$(spend_blocked_until 1)" "$((H + 18000))"
eq "acct 2 under every budget: not blocked" "$(spend_blocked_until 2)" 0
GO2_BUDGET_5H=1 ; eq "acct 2 own budget GO2_BUDGET_5H=1 (spent 2): blocked" "$([[ $(spend_blocked_until 2) -gt 0 ]] && echo yes || echo no)" yes; unset GO2_BUDGET_5H
eq "acct 1 budgets untouched by GO2_*" "$(go_budget 1 5H)/$(go_budget 1 WEEK)/$(go_budget 1 MONTH)" "14/36/76"
echo "-- budget_sync cools only the account that is over budget"
budget_sync "$M1" "$M2" "$FREE"
eq "acct 1 cooling (budget)" "$(is_cooling "$M1" && echo yes || echo no)" yes
eq "acct 1 reason" "$(cooldown_reason "$M1")" budget
eq "acct 2 not cooling" "$(is_cooling "$M2" && echo yes || echo no)" no
eq "free model never touched by budget_sync" "$(is_cooling "$FREE" && echo yes || echo no)" no

echo "== eligibility and choice of account"
cat > "$UI/models.json" <<JSON
{"v":1,"free":[{"id":"opencode/deepseek-v4.1-flash-free","zero_retention":true}],
 "paid":[{"id":"$M1","zero_retention":true},{"id":"$M2","zero_retention":true}]}
JSON
eq "models_eligible lists both accounts, paid first" "$(models_eligible "$UI/models.json")" "[\"$M1\",\"$M2\",\"$FREE\"]"
CTRL="[\"$M1\",\"$M2\"]"
ELIG="[\"$M1\",\"$M2\"]"
eff() { models_effective "$CTRL" "$ELIG" "$1"; }
eq "nothing cooling: acct 1 first, acct 2 second" "$(eff '[]')" "[\"$M1\",\"$M2\"]"
eq "acct 1 cooling (cap): acct 2 is tried first" "$(eff "[\"$M1\"]")" "[\"$M2\",\"$M1\"]"
eq "acct 2 cooling: acct 1 stays first" "$(eff "[\"$M2\"]")" "[\"$M1\",\"$M2\"]"
echo "-- lane picks the first non-cooling in that order (run.sh loop), or backs off"
rm -f "$STATE"/cooldown/*; export NOW=$(epoch 2026-10-25T20:13:30Z)
cooldown_hit "$M1" usage_cap
pick() { local m; for m in $(jq -r '.[]' <<<"$1"); do if ! is_cooling "$m"; then echo "$m"; return; fi; done; echo NONE; }
eq "acct 1 usage_cap -> pick" "$(pick "$(eff "[\"$M1\"]")")" "$M2"
cooldown_hit "$M2" usage_cap
eq "both usage_cap -> NONE (lane backs off)" "$(pick "$(eff "[\"$M1\",\"$M2\"]")")" NONE
EFF_MODELS=("$M1" "$M2")
echo "note: $(earliest_cooldown_note)"
eq "note names both accounts and the return time" "$(earliest_cooldown_note | grep -c 'account 1 until Mon 2026-10-26 00:00Z (weekly Go quota used up); account 2 until Mon 2026-10-26 00:00Z')" 1
export NOW=$(epoch 2026-10-25T10:00:00Z); rm -f "$STATE"/cooldown/*
printf '%s 1 usage_cap\n' "$(epoch 2026-10-26T00:00:00Z)" > "$(cooldown_file "$M1")"
printf '%s 1 rate_limit\n' "$(epoch 2026-10-25T10:10:00Z)" > "$(cooldown_file "$M2")"
eq "different return times are listed per account" "$(earliest_cooldown_note | grep -c 'account 1 until Mon 2026-10-26 00:00Z.*; account 2 until Sun 2026-10-25 10:10Z')" 1
rm -f "$STATE"/cooldown/*
printf '%s 1 usage_cap\n' "$(epoch 2026-10-26T00:00:00Z)" > "$(cooldown_file "$M1")"
EFF_MODELS=("$M1")
eq "single cooling model: C4 note format unchanged" "$(earliest_cooldown_note | grep -c '^until Mon 2026-10-26 00:00Z (weekly OpenCode Go quota used up')" 1

echo "== sandbox.sh: SB_CRED validation"
for bad in "go2" "go2:relative/path" "go 2:/x" 'go2:/x;y z'; do
  out=$(SB_CRED=$bad SB_GATE=1 SB_SLOT=9 bash "$SBX" /home/factory/s9 5 true 2>&1); rc=$?
  eq "SB_CRED='$bad' refused" "$rc:$(echo "$out" | head -c 40)" "2:sandbox: bad SB_CRED entry"
done

echo "== wrapper: per-process managed config, account 1 untouched"
# The wrapper is orchestrator/factory-opencode (installed as /usr/local/bin/factory-opencode); a
# missing one is skipped and says so, it does not pass silently.
if [[ ! -x $WRAP ]]; then
  echo "SKIP  wrapper section: $WRAP is not installed (pass its path as the 4th argument)"
else
mkdir -p "$T/bin" "$T/cred" "$T/etc"
cat > "$T/etc/opencode.json" <<'JSON'
{"enabled_providers":["opencode","opencode-go"],"provider":{"opencode-go":{"options":{"apiKey":"{file:/etc/opencode/go.key}"},"whitelist":["deepseek-v4.1-flash"]}}}
JSON
cp "$T/etc/opencode.json" "$T/etc.before"
# stub opencode: reports what it was handed, never a key
cat > "$T/bin/opencode" <<'STUB'
#!/bin/bash
echo "args=$*"
echo "managed_dir=${OPENCODE_TEST_MANAGED_CONFIG_DIR:-unset}"
if [[ -n ${OPENCODE_TEST_MANAGED_CONFIG_DIR:-} ]]; then grep -o '"apiKey":"[^"]*"' "$OPENCODE_TEST_MANAGED_CONFIG_DIR/opencode.json"; fi
STUB
chmod +x "$T/bin/opencode"
printf 'FAKE-KEY-CONTENT-FOR-TESTS-0000000' > "$T/cred/go2"
o=$(PATH=$T/bin:$PATH FACTORY_MANAGED_CONFIG=$T/etc/opencode.json TMPDIR=$T "$WRAP" run -m opencode-go/deepseek-v4.1-flash hi)
eq "no credential: opencode runs as is (account 1 default)" "$(grep -c 'managed_dir=unset' <<<"$o")" 1
o=$(PATH=$T/bin:$PATH FACTORY_MANAGED_CONFIG=$T/etc/opencode.json TMPDIR=$T CREDENTIALS_DIRECTORY=$T/cred "$WRAP" run -m opencode-go/deepseek-v4.1-flash hi)
eq "with go2 credential: private managed dir set" "$(grep -c "managed_dir=$T/factory-oc\." <<<"$o")" 1
eq "apiKey reference now points at the credential file" "$(grep -c "\"apiKey\":\"{file:$T/cred/go2}\"" <<<"$o")" 1
eq "real -m passed through untouched" "$(grep -c 'args=run -m opencode-go/deepseek-v4.1-flash hi' <<<"$o")" 1
eq "key text appears nowhere in the wrapper output (argv/env/printed)" "$(grep -c FAKE-KEY <<<"$o")" 0
eq "/etc managed config unchanged" "$(cmp -s "$T/etc/opencode.json" "$T/etc.before" && echo same || echo changed)" same
echo '{"provider":{"opencode-go":{"options":{"apiKey":"{file:/somewhere/else}"}}}}' > "$T/etc/other.json"
o=$(PATH=$T/bin:$PATH FACTORY_MANAGED_CONFIG=$T/etc/other.json TMPDIR=$T CREDENTIALS_DIRECTORY=$T/cred "$WRAP" run x 2>&1); rc=$?
eq "no account-1 reference in managed config: refuses (rc 97, would bill account 1)" "$rc" 97
fi

echo; echo "passed=$pass failed=$fail"
[[ $fail == 0 ]]
