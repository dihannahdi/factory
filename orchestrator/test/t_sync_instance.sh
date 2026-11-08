#!/usr/bin/env bash
# A second instance on the same box that must only ever use free models: GO_MODELS= and GO_ACCOUNTS=
# (empty) switch every paid path off even with Go keys in place, WHITELIST_WRITE=0 leaves the shared
# /etc/opencode/opencode.json to the other instance's sync, step_zen_key looks through the instance's
# own first slot, and a turn that costs money on a free model still halts every lane.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env

mkdir -p "$T/gh" "$T/curl"
export FAKE_GH_DIR=$T/gh FAKE_CURL_DIR=$T/curl GH_TOKEN_FILE=$T/token OPENCODE_CONF=$T/opencode.json OPENCODE_TEMPLATE=$ORCH/opencode.json
export FAKE_ACTIVE=inactive
echo tok > "$GH_TOKEN_FILE"
echo '[]' > "$T/gh/issues.json"; echo '[]' > "$T/gh/prs.json"
FREE='deepseek-v4.1-flash-free longcat-2.5-preview-free space-bunny-free'
jq -nc --arg f "$FREE" '{data: ($f | [splits(" ")] | map({id: .}))}' > "$T/curl/zen.json"
jq -nc --arg f "$FREE" '
  {opencode: {models: ($f | [splits(" ")] | map({key: ., value: {name: ., cost: {input: 0, output: 0}, limit: {context: 1000, output: 100}}}) | from_entries)},
   "opencode-go": {models: {"deepseek-v4.1-flash": {name: "DeepSeek V4.1 Flash", cost: {input: 0.15, output: 0.6}, limit: {context: 200000, output: 32000}}}}}' > "$T/curl/modelsdev.json"
cp "$ORCH/opencode.json" "$T/opencode.json"
printf '%s\n' 'stub_spend() { printf "{\"h5\":0,\"week\":0,\"month\":0}\n"; }' > "$T/stub.sh"
export BASH_ENV=$T/stub.sh SPEND_FN=stub_spend
export SANDBOX=$T/none

# Both Go keys are in place and safe: the strongest case for "still no paid model".
KEY=$T/go.key KEY2=$T/go2.key
head -c 40 /dev/zero | tr '\0' k > "$KEY";  echo "root factory 640 40" > "$KEY.stat"
head -c 40 /dev/zero | tr '\0' k > "$KEY2"; echo "root root 600 40" > "$KEY2.stat"
export GO_KEY_FILE=$KEY GO2_KEY_FILE=$KEY2 GO_KEY_OWNER=root GO_KEY_GROUP=factory GO_KEY_DIR=$T
run_sync() { rm -f "$STATE/.models-stamp" "$STATE/go-models.json"; bash "$ORCH/sync.sh" >"$T/sync.out" 2>&1; }
sync_var() { bash -c 'source "$1"; echo "${!2}"' _ "$ORCH/sync.sh" "$2"; }

echo "the defaults"
assert_eq "GO_MODELS default" "opencode-go/deepseek-v4.1-flash opencode-go@2/deepseek-v4.1-flash" "$(env -u GO_MODELS bash -c 'source "$1"; echo "$GO_MODELS"' _ "$ORCH/sync.sh")"
assert_eq "GO_ACCOUNTS default" "1 2" "$(env -u GO_ACCOUNTS bash -c 'source "$1"; echo "$GO_ACCOUNTS"' _ "$ORCH/sync.sh")"
assert_eq "empty GO_MODELS stays empty" "[]" "[$(GO_MODELS= bash -c 'source "$1"; echo "$GO_MODELS"' _ "$ORCH/sync.sh")]"
assert_eq "empty GO_ACCOUNTS stays empty" "[]" "[$(GO_ACCOUNTS= bash -c 'source "$1"; echo "$GO_ACCOUNTS"' _ "$ORCH/sync.sh")]"
assert_eq "WHITELIST_WRITE default" 1 "$(env -u WHITELIST_WRITE bash -c 'source "$1"; echo "$WHITELIST_WRITE"' _ "$ORCH/sync.sh")"

echo "nothing set: the Go models are offered when the keys are safe"
run_sync
assert_eq "paid = both Go accounts' models" '["opencode-go/deepseek-v4.1-flash","opencode-go@2/deepseek-v4.1-flash"]' "$(jq -c '[.paid[].id]' "$UI/models.json")"

echo "the free-only instance: GO_MODELS= GO_ACCOUNTS= WHITELIST_WRITE=0, with both Go keys present and safe"
export GO_MODELS= GO_ACCOUNTS= WHITELIST_WRITE=0 GO_BUDGET_5H=0 GO_BUDGET_WEEK=0 GO_BUDGET_MONTH=0
rm -rf "$UI/models.json" "$STATE"
mkdir -p "$STATE"
# The shared file holds the OTHER instance's state (its Go provider); this sync must not touch it.
jq '.provider["opencode-go"] = {options: {apiKey: "{file:/etc/opencode/go.key}"}, whitelist: ["x"]} | .enabled_providers = ["opencode","opencode-go"]' "$ORCH/opencode.json" > "$OPENCODE_CONF"
before=$(cksum < "$OPENCODE_CONF")
run_sync
assert_eq "models.json is written, free models listed" 3 "$(jq '.free | length' "$UI/models.json")"
assert_false "no paid key in models.json" jq -e 'has("paid")' "$UI/models.json"
assert_eq "no Go account has a budget row" '{}' "$(jq -c '.spend.accounts' "$UI/models.json")"
assert_eq "the shared opencode.json was not rewritten" "$before" "$(cksum < "$OPENCODE_CONF")"
assert_false "and sync did not say it rewrote it" grep -q 'whitelist rewritten' "$T/sync.out"
elig=$(bash -c 'source "$1"; models_eligible "$2"' _ "$ORCH/lib.sh" "$UI/models.json")
assert_eq "what a lane may use: the free zero-retention models only" '["opencode/deepseek-v4.1-flash-free","opencode/longcat-2.5-preview-free","opencode/space-bunny-free"]' "$elig"
assert_false "no opencode-go id among them" grep -q opencode-go <<<"$elig"
eff=$(bash -c 'source "$1"; models_effective "$2" "$3" "[]"' _ "$ORCH/lib.sh" '["opencode-go/deepseek-v4.1-flash","opencode-go@2/deepseek-v4.1-flash"]' "$elig")
assert_eq "a Go model typed into control.models is dropped, not used" '["opencode/deepseek-v4.1-flash-free"]' "$eff"

echo "WHITELIST_WRITE unset: the owner (first instance) still rewrites it"
unset WHITELIST_WRITE
run_sync
assert_eq "the free whitelist is written" 3 "$(jq '.provider.opencode.whitelist | length' "$OPENCODE_CONF")"
assert_false "and the Go provider is gone with no paid model" jq -e '.provider | has("opencode-go")' "$OPENCODE_CONF"
export WHITELIST_WRITE=0

echo "step_zen_key looks through the instance's first slot"
cat > "$T/sb-probe.sh" <<'EOF'
#!/usr/bin/env bash
echo "SB_SLOT=$SB_SLOT workdir=$1" >> "$PROBE_LOG"
exit 0
EOF
chmod +x "$T/sb-probe.sh"
export PROBE_LOG=$T/probe.log SANDBOX=$T/sb-probe.sh
zen() { rm -f "$STATE/.authcheck"; : > "$PROBE_LOG"; bash -c 'source "$1"; step_zen_key' _ "$ORCH/sync.sh"; }
mkdir -p "$H/s1" "$H/s4"
SLOTS="4 5" zen
assert_eq "SLOTS 4 5: slot 4, in s4, both probes" "SB_SLOT=4 workdir=$H/s4|SB_SLOT=4 workdir=$H/s4" "$(paste -sd'|' "$PROBE_LOG")"
unset SLOTS; zen
assert_eq "default: slot 1, in s1, as before" "SB_SLOT=1 workdir=$H/s1|SB_SLOT=1 workdir=$H/s1" "$(paste -sd'|' "$PROBE_LOG")"
rm -rf "$H/s4"; SLOTS="4 5" zen
assert_eq "no s4 yet: no sandbox call" 0 "$(wc -l < "$PROBE_LOG")"
mkdir -p "$H/s4"
echo "the real sandbox.sh accepts exactly that slot and refuses slot 1 under SLOTS 4 5"
export FAKE_SYSTEMD_RUN_LOG=$T/sdrun.log; : > "$FAKE_SYSTEMD_RUN_LOG"
( cd "$T"; SLOTS="4 5" SB_SLOT=4 bash "$ORCH/sandbox.sh" /home/factory/s4 15 true >/dev/null 2>&1 ); assert_eq "slot 4 ok" 0 "$?"
( cd "$T"; SLOTS="4 5" SB_SLOT=1 bash "$ORCH/sandbox.sh" /home/factory/s1 15 true >/dev/null 2>&1 ); assert_eq "slot 1 refused" 2 "$?"

echo "cost > 0 on a free model still halts every lane of the free-only instance"
unset BASH_ENV SANDBOX SPEND_FN
export SLOTS="4 5" GO_MODELS= GO_ACCOUNTS=
source "$ORCH/run.sh"
set +e; set +u
export FAKE_LOG=$T/fake.log FAKE_SYSTEMCTL_LOG=$T/systemctl.log DISK_STOP_GB=0 DISK_ONE_GB=0
export SANDBOX=$TESTDIR/bin/fake-sandbox.sh PROMPTS=$ORCH/prompts
K=4 RUN_ID=run-AAA SLOTDIR=$H/s4 WORK=$H/s4/work OUT=$H/s4/out
mkdir -p "$WORK" "$STATE/claims" "$STATE/locks" "$STATE/cooldown"
run=$T/log/issue-5-x-s4; mkdir -p "$run"
ST_RUN=$RUN_ID n=5 base=deadbeef ST_STATE=running ST_STAGE="" ST_SUB="" ST_NOTE="" ST_STEER_PENDING=null ST_STEER_LAST=null ST_INTR_JSON=null ISB_KIND=turn
EFF_MODELS=(opencode/a-free)
: > "$FAKE_LOG"; : > "$FAKE_SYSTEMCTL_LOG"; rm -f "$UI/halt.json"
export FAKE_MODE=cost
( agent build 60 "x" ) >/dev/null 2>&1; rc=$?
assert_eq "exit 0" 0 "$rc"
assert_true "halt.json written with slug cost" bash -c "jq -r .id '$UI/halt.json' | grep -Eq '^[0-9]+-cost$'"
assert_eq "status halted, in slot 4's file" halted "$(jq -r .state "$UI/slots/4.json")"
CONTROL=$CONTROL_DEFAULT
assert_true "the other lane sees it" halted
( agent build 60 "x" ) >/dev/null 2>&1
assert_eq "a halted lane starts no turn" 1 "$(grep -c 'cmd=opencode' "$FAKE_LOG")"
assert_false "nothing went to the Go ledger" test -s "$SPEND"

finish
