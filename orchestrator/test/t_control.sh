#!/usr/bin/env bash
# control.json validation and the fallback chain (file -> last good -> defaults).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/lib.sh"
set +e

echo "control validation"
v=$(control_validate "$FIX/ctl/control.json")
assert_eq "fixture control.json is valid" 0 "$?"
assert_eq "fixture: agents kept" 2 "$(jq .agents <<<"$v")"
assert_eq "fixture: queue normalized to {n,at}" '[{"n":37,"at":"2026-10-16T05:00:00Z"}]' "$(jq -c .queue <<<"$v")"
assert_eq "fixture: updated_at dropped (unknown key)" null "$(jq -c '.updated_at' <<<"$v")"

try() {  # try <name> <json> <expect valid|invalid>
  printf '%s' "$2" > "$T/c.json"
  if control_validate "$T/c.json" >/dev/null 2>&1; then r=valid; else r=invalid; fi
  assert_eq "$1" "$3" "$r"
}
try "agents 3 ok" '{"v":1,"agents":3}' valid
try "agents 0 ok" '{"v":1,"agents":0}' valid
try "agents 4 rejected" '{"v":1,"agents":4}' invalid
try "agents 1.5 rejected" '{"v":1,"agents":1.5}' invalid
try "agents string rejected" '{"v":1,"agents":"2"}' invalid
try "wrong v rejected" '{"v":2,"agents":1}' invalid
try "not an object rejected" '[1]' invalid
try "garbage rejected" 'not json' invalid
try "model without prefix rejected" '{"v":1,"models":["deepseek-v4.1-flash-free"]}' invalid
try "model with shell metachar rejected" '{"v":1,"models":["opencode/x;rm -rf /"]}' invalid
try "model uppercase rejected" '{"v":1,"models":["opencode/DeepSeek"]}' invalid
try "6 models rejected" '{"v":1,"models":["opencode/a","opencode/b","opencode/c","opencode/d","opencode/e","opencode/f"]}' invalid
try "empty models rejected" '{"v":1,"models":[]}' invalid
try "bad model_mode rejected" '{"v":1,"model_mode":"random"}' invalid
try "auto mode ok" '{"v":1,"model_mode":"auto"}' valid
try "paused must be boolean" '{"v":1,"paused":"yes"}' invalid
try "queue entry needs ISO at" '{"v":1,"queue":[{"n":3,"at":"yesterday"}]}' invalid
try "queue n must be positive" '{"v":1,"queue":[{"n":0,"at":"2026-10-16T05:00:00Z"}]}' invalid
try "skip must be ints" '{"v":1,"skip":["76"]}' invalid
try "resume_ack with shell syntax rejected" '{"v":1,"resume_ack":"$(id)"}' invalid
try "resume_ack ok" '{"v":1,"resume_ack":"1792130000-deploy"}' valid
big=$(jq -nc '{v:1, queue: [range(0;51) | {n: (.+1), at: "2026-10-16T05:00:00Z"}]}')
try "51 queue entries rejected" "$big" invalid
big=$(jq -nc '{v:1, skip: [range(1;202)]}')
try "201 skip entries rejected" "$big" invalid
big=$(jq -nc '{v:1, skip: [range(1;201)]}')
try "200 skip entries ok" "$big" valid
printf '%s' '{"v":1,"models":["opencode/a","opencode/b","opencode/a"],"skip":[5,3,5]}' > "$T/c.json"
dup=$(control_validate "$T/c.json")
assert_eq "models de-duplicated in order, skip unique" '{"m":["opencode/a","opencode/b"],"s":[3,5]}' "$(jq -c '{m:.models,s:.skip}' <<<"$dup")"

echo "file checks"
head -c 70000 /dev/zero | tr '\0' ' ' > "$T/big.json"; printf '{"v":1}' >> "$T/big.json"
assert_false "file over 64 KB refused" control_validate "$T/big.json"
assert_false "missing file refused" control_validate "$T/nope.json"
mkdir "$T/dir.json"
assert_false "directory refused" control_validate "$T/dir.json"
printf '{"v":1}' > "$T/real.json"
if ln -s "$T/real.json" "$T/link.json" 2>/dev/null && [[ -L $T/link.json ]]; then
  assert_false "symlink refused" control_validate "$T/link.json"
else
  echo "  skip symlink test (this shell cannot create real symlinks)"
fi

echo "fallback chain"
rm -f "$CTL/control.json" "$STATE/control.last-good.json"
control_load
assert_eq "no file: defaults" default "$CONTROL_SOURCE"
assert_eq "defaults: 1 agent" 1 "$(jq .agents <<<"$CONTROL")"
cp "$FIX/ctl/control.json" "$CTL/control.json"
control_load
assert_eq "valid file: used" file "$CONTROL_SOURCE"
assert_eq "valid file: agents 2" 2 "$(jq .agents <<<"$CONTROL")"
assert_true "last-good written" test -s "$STATE/control.last-good.json"
printf '{"v":1,"agents":9}' > "$CTL/control.json"
control_load
assert_eq "invalid file: last good" last-good "$CONTROL_SOURCE"
assert_eq "invalid file: last good agents 2" 2 "$(jq .agents <<<"$CONTROL")"
rm -f "$STATE/control.last-good.json"
control_load
assert_eq "invalid file and no last good: defaults" default "$CONTROL_SOURCE"
finish
