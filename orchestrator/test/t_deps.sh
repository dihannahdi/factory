#!/usr/bin/env bash
# Known-blocked issues are skipped before any plan turn: dependencies declared in the issue text
# ("Bergantung pada") and the ones a plan recorded (STATE/blocked) both keep it off the pick list
# while any of them is still open.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/lib.sh"
set +e
export NOW=1792130000
mk() { jq -nc --argjson n "$1" --arg t "$2" --arg b "$3" '{number: $n, title: $t, body: $b, labels: [{name: "P0"}], milestone: {title: "M1"}, assignees: []}'; }
{
  mk 17 "[MET-01] source" "Not blocked by anything."
  mk 18 "[MET-02] second source" "x"
  mk 22 "[ENG-22] base" "x"
  mk 23 "[SHD-01] shadows" $'**Bergantung pada**: #22, #3, #9, #2\n\nbody'
  mk 21 "[YLD-01] yield" $'**Bergantung pada**: #18, #17. The PDF is rendered through #26; until that issue is done, the output is JSON.'
  mk 26 "[OUT-12] report" $'**Bergantung pada**: #3, #8, #10, #23 (the report sub-task only)\n\n**Context** see #99'
  mk 30 "[ENG-30] free" $'Depends on: #31\nbody'
  mk 31 "[ENG-31] closed later" "x"
  mk 32 "[ENG-32] from the plan" "no dependency line"
  mk 33 "[ENG-33] numbers in prose" $'Context: see #17 and #18.'
} | jq -sc . > "$T/issues.json"
echo '[]' > "$T/prs.json"
mkdir -p "$STATE/claims" "$STATE/blocked"
echo '[18]' > "$STATE/blocked/32"          # a plan turn recorded: #32 waits for #18
echo '[99]' > "$STATE/blocked/33"          # recorded dep that is already closed: no longer blocks
control_load
d=$T/work; mkdir -p "$d"; cp "$T/issues.json" "$d/issues.json"; cp "$T/prs.json" "$d/prs.json"
gather_local "$d"
blocked=$(cat "$d/blocked.json")
assert_json_eq "declared deps, open only, first line only, cut at the full stop" '{"21":[17,18],"23":[22],"26":[23],"30":[31],"32":[18],"33":[]}' "$blocked"
out=$(classify_run "$d")
cls() { jq -r --argjson n "$1" '.[] | select(.n == $n) | .class' <<<"$out"; }
assert_eq "#21 waits (declared, 2 open)" blocked "$(cls 21)"
assert_eq "#26 waits for #23 (was planned twice before)" blocked "$(cls 26)"
assert_eq "#23 waits for #22" blocked "$(cls 23)"
assert_eq "#32 waits (recorded by a plan)" blocked "$(cls 32)"
assert_eq "#30 waits for #31 (English form)" blocked "$(cls 30)"
assert_eq "#33: a number in prose and a closed recorded dep do not block" eligible "$(cls 33)"
assert_eq "#17 has no deps" eligible "$(cls 17)"
assert_eq "reason names the deps" "waiting for #17, #18" "$(jq -r '.[] | select(.n == 21) | .reason' <<<"$out")"
# once #23 is closed the issue is eligible again
jq 'map(select(.number != 23))' "$T/issues.json" > "$d/issues.json"; gather_local "$d"
assert_eq "dependency closed: #26 is eligible again" eligible "$(classify_run "$d" | jq -r '.[] | select(.n == 26) | .class')"
echo "waiters_of: who waits for #n, directly or through others"
g='{"23":[58],"58":[23,29],"26":[23],"33":[23,32],"99":[26],"29":[],"40":[41]}'
assert_eq "#58 (declares #23), #26, #33 and #99 (through #26)" "[26,33,58,99]" "$(waiters_of 23 <<<"$g")"
assert_eq "nobody waits for #41's dependents" "[40]" "$(waiters_of 41 <<<"$g")"
assert_eq "an issue nobody waits for" "[]" "$(waiters_of 7 <<<"$g")"
assert_eq "an empty graph" "[]" "$(waiters_of 23 <<<'{}')"

finish
