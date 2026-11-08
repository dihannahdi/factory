#!/usr/bin/env bash
# sync.sh and OpenCode Go: the free classifier against the Zen privacy page, the Go key safety
# check, the managed config with and without the key, and models.json paid/spend.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env

mkdir -p "$T/gh" "$T/curl"
export FAKE_GH_DIR=$T/gh FAKE_CURL_DIR=$T/curl GH_TOKEN_FILE=$T/token OPENCODE_CONF=$T/opencode.json OPENCODE_TEMPLATE=$ORCH/opencode.json
export SANDBOX=$T/none FAKE_ACTIVE=inactive
echo tok > "$GH_TOKEN_FILE"
echo '[]' > "$T/gh/issues.json"; echo '[]' > "$T/gh/prs.json"
FREE='big-pickle cat-jam-free deepseek-v4.1-flash-free exo-free glm-5.3-flash-free ll-alpha-free longcat-2.5-preview-free
      mimo-v2.5-free mimo-v2.6-flash-free muse-spark-1.2-contributor-free muse-spark-1.3-contributor-free
      nemotron-3.5-lightning-free nemotron-3.5-super-vl-free space-bunny-free'
jq -nc --arg f "$FREE" '{data: ($f | [splits("[ 
]+")] | map(select(length > 0)) | map({id: .}))}' > "$T/curl/zen.json"
jq -nc --arg f "$FREE" '
  {opencode: {models: ($f | [splits("[ 
]+")] | map(select(length > 0)) | map({key: ., value: {name: ., cost: {input: 0, output: 0}, limit: {context: 1000, output: 100}}}) | from_entries)},
   "opencode-go": {models: {
     "deepseek-v4.1-flash": {name: "DeepSeek V4.1 Flash", cost: {input: 0.15, output: 0.6}, limit: {context: 200000, output: 32000}},
     "kimi-k3": {name: "Kimi K3", cost: {input: 3, output: 15}, limit: {context: 262144, output: 32000}}}}}' > "$T/curl/modelsdev.json"
cp "$ORCH/opencode.json" "$T/opencode.json"

# A spend stub: sync calls $SPEND_FN, so this keeps working once lib.sh grows the real spend_summary.
printf '%s\n' 'stub_spend() { printf "{\"h5\":1.23,\"week\":4.5,\"month\":6}\n"; }' > "$T/stub.sh"
export BASH_ENV=$T/stub.sh SPEND_FN=stub_spend

KEY=$T/go.key
export GO_KEY_FILE=$KEY GO_KEY_OWNER=root GO_KEY_GROUP=factory
export GO_MODELS='opencode-go/deepseek-v4.1-flash opencode-go/not-in-modelsdev'
run_sync() { rm -f "$STATE/.models-stamp"; bash "$ORCH/sync.sh" >"$T/sync.out" 2>&1; }
setkey() {  # setkey <owner> <group> <mode> <size>
  head -c "$4" /dev/zero | tr '\0' 'k' > "$KEY"
  printf '%s %s %s %s\n' "$1" "$2" "$3" "$4" > "$KEY.stat"
}
key_status() { bash -c 'source "$1"; go_key_status' _ "$ORCH/sync.sh"; }

echo "classifier: every free model of the Zen privacy page"
run_sync
cls=$(jq -r '.free[] | "\(.id | ltrimstr("opencode/")) \(.trains_on_data) \(.zero_retention)"' "$UI/models.json")
chk() { assert_eq "$1: trains=$2 zero_retention=$3" "$1 $2 $3" "$(grep "^$1 " <<<"$cls")"; }
chk big-pickle true false
chk cat-jam-free false false
chk deepseek-v4.1-flash-free false true
chk exo-free true false
chk glm-5.3-flash-free null null
chk ll-alpha-free true false
chk longcat-2.5-preview-free false true
chk mimo-v2.5-free true false
chk mimo-v2.6-flash-free true false
chk muse-spark-1.2-contributor-free true false
chk muse-spark-1.3-contributor-free true false
chk nemotron-3.5-lightning-free true false
chk nemotron-3.5-super-vl-free true false
chk space-bunny-free false true
assert_eq "whitelist is still every free model (the console marks, the human decides)" 14 "$(jq '.provider.opencode.whitelist | length' "$OPENCODE_CONF")"

echo "no Go key"
assert_false "no paid" jq -e 'has("paid")' "$UI/models.json"
assert_eq "enabled_providers = [opencode]" '["opencode"]' "$(jq -c .enabled_providers "$OPENCODE_CONF")"
assert_eq "no opencode-go block" false "$(jq '.provider | has("opencode-go")' "$OPENCODE_CONF")"
assert_eq "webfetch not denied" unset "$(jq -r '.permission.webfetch // "unset"' "$OPENCODE_CONF")"
assert_eq "spend published from the spend function, with budgets" '{"h5":1.23,"week":4.5,"month":6,"budget":{"h5":14,"week":36,"month":76}}' "$(jq -c '.spend | del(.accounts)' "$UI/models.json")"
assert_eq "...and one entry per Go account" '["1","2"]' "$(jq -c '.spend.accounts | keys' "$UI/models.json")"

echo "key present and safe"
setkey root factory 640 40
run_sync
assert_eq "status ok" ok "$(key_status)"
assert_eq "paid = the configured Go models models.dev knows (typo dropped)" '["opencode-go/deepseek-v4.1-flash"]' "$(jq -c '[.paid[].id]' "$UI/models.json")"
assert_eq "paid entry: documented ZDR, not trained" 'false true' "$(jq -r '.paid[0] | "\(.trains_on_data) \(.zero_retention)"' "$UI/models.json")"
assert_eq "paid entry keys" '["context","id","name","output","trains_on_data","zero_retention"]' "$(jq -c '.paid[0] | keys' "$UI/models.json")"
assert_eq "enabled_providers" '["opencode","opencode-go"]' "$(jq -c .enabled_providers "$OPENCODE_CONF")"
assert_eq "apiKey is a file reference" "{file:$KEY}" "$(jq -r '.provider["opencode-go"].options.apiKey' "$OPENCODE_CONF")"
assert_eq "Go whitelist" '["deepseek-v4.1-flash"]' "$(jq -c '.provider["opencode-go"].whitelist' "$OPENCODE_CONF")"
assert_eq "free whitelist unchanged" 14 "$(jq '.provider.opencode.whitelist | length' "$OPENCODE_CONF")"
assert_false "the key content never reaches the config, models.json or the log" grep -q kkkkkkkk "$OPENCODE_CONF" "$UI/models.json" "$T/sync.out"
assert_eq "webfetch still not denied" unset "$(jq -r '.permission.webfetch // "unset"' "$OPENCODE_CONF")"
assert_eq "models.json keys with paid and spend" '["cooldown","free","paid","source_ok","spend","updated","v"]' "$(jq -c keys "$UI/models.json")"

echo "a Go model in cooldown shows up under cooldown"
export NOW=$(date +%s) K=1 RUN_ID=x
( source "$ORCH/lib.sh"; cooldown_hit opencode-go/deepseek-v4.1-flash rate_limit )
bash "$ORCH/sync.sh" >/dev/null 2>&1
assert_eq "cooldown of a paid model" rate_limit "$(jq -r '.cooldown["opencode-go/deepseek-v4.1-flash"].reason' "$UI/models.json")"
unset NOW K RUN_ID

echo "no spend function: spend omitted"
SPEND_FN=no_such_fn bash "$ORCH/sync.sh" >/dev/null 2>&1
assert_false "spend absent" jq -e 'has("spend")' "$UI/models.json"
assert_eq "paid stays" 1 "$(jq '.paid | length' "$UI/models.json")"

echo "budgets from the environment (junk falls back to the default)"
GO_BUDGET_5H=20 GO_BUDGET_WEEK=abc bash "$ORCH/sync.sh" >/dev/null 2>&1
assert_eq "budget" '{"h5":20,"week":36,"month":76}' "$(jq -c .spend.budget "$UI/models.json")"

echo "unsafe keys: Go switched off on the next run"
unsafe() {  # unsafe <name> <owner> <group> <mode> <size>
  setkey "$2" "$3" "$4" "$5"
  run_sync
  assert_eq "$1: status unsafe" unsafe "$(key_status | cut -d: -f1)"
  assert_false "$1: no paid" jq -e 'has("paid")' "$UI/models.json"
  assert_eq "$1: enabled_providers back to [opencode]" '["opencode"]' "$(jq -c .enabled_providers "$OPENCODE_CONF")"
  assert_eq "$1: no opencode-go block" false "$(jq '.provider | has("opencode-go")' "$OPENCODE_CONF")"
}
setkey root factory 640 40; run_sync
assert_eq "key back: Go enabled again" '["opencode","opencode-go"]' "$(jq -c .enabled_providers "$OPENCODE_CONF")"
unsafe "mode 0644" root factory 644 40
unsafe "mode 0600" root factory 600 40
unsafe "wrong owner" mallory factory 640 40
unsafe "wrong group" root users 640 40
unsafe "too small" root factory 640 10
unsafe "too big" root factory 640 600
rm -f "$KEY" "$KEY.stat"
printf 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkk\n' > "$T/real.key"
printf 'root factory 640 40\n' > "$T/real.key.stat"
if MSYS=winsymlinks:nativestrict ln -s "$T/real.key" "$KEY" 2>/dev/null && [[ -L $KEY ]]; then
  run_sync
  assert_eq "symlink: status" "unsafe:symlink" "$(key_status)"
  assert_false "symlink: no paid" jq -e 'has("paid")' "$UI/models.json"
  assert_eq "symlink: Go off" '["opencode"]' "$(jq -c .enabled_providers "$OPENCODE_CONF")"
else
  ok "symlink: skipped (no symlinks on this host)"
fi
rm -f "$KEY" "$T/real.key" "$T/real.key.stat"
mkdir "$KEY"
run_sync
assert_eq "a directory is not a key" "unsafe:not a regular file" "$(key_status)"
rmdir "$KEY"
run_sync
assert_eq "key removed: absent" absent "$(key_status)"
assert_false "key removed: no paid" jq -e 'has("paid")' "$UI/models.json"

echo "a key with every Go model unknown to models.dev enables nothing"
setkey root factory 640 40
GO_MODELS=opencode-go/typo run_sync
assert_false "no paid" jq -e 'has("paid")' "$UI/models.json"
assert_eq "provider stays off (an empty whitelist would allow everything)" '["opencode"]' "$(jq -c .enabled_providers "$OPENCODE_CONF")"
finish
