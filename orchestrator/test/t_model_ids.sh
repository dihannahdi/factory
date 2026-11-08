#!/usr/bin/env bash
# Model id grammar, shared with the console (contracts/fixtures/model-ids.json). The console's
# MODEL_RE is tested against the same file in console/test/unit.test.mjs; if the two sides disagree,
# the console drops an id that root accepts (31 Oct 2026: Go account 2 vanished from control.json).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/lib.sh"
set +e

echo "valid_model and control_validate against the shared fixture"
mapfile -t VALID < <(jq -r '.valid[]' "$FIX/model-ids.json" | tr -d '\r')
mapfile -t INVALID < <(jq -r '.invalid[]' "$FIX/model-ids.json" | tr -d '\r')
(( ${#VALID[@]} > 0 && ${#INVALID[@]} > 0 )) && ok "fixture has both lists" || bad "fixture has both lists"

for id in "${VALID[@]}"; do
  assert_true "valid_model accepts $id" valid_model "$id"
  jq -nc --arg m "$id" '{v: 1, models: [$m]}' > "$T/c.json"
  assert_eq "control_validate keeps $id" "[\"$id\"]" "$(control_validate "$T/c.json" | jq -c .models)"
done
for id in "${INVALID[@]}"; do
  assert_false "valid_model rejects '$id'" valid_model "$id"
  jq -nc --arg m "$id" '{v: 1, models: [$m]}' > "$T/c.json"
  assert_false "control_validate rejects '$id'" control_validate "$T/c.json"
done

finish
