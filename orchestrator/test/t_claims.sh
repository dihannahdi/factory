#!/usr/bin/env bash
# Claims: staleness rule, take/release, tombstones, lock ordering.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/lib.sh"
set +e

echo "claim_is_stale (pure)"
live='{"slot":1,"run_id":"inv-1","at":100,"state":"active"}'
stale() { claim_is_stale "$1" "$2" "$3" "$4" && echo stale || echo live; }
assert_eq "active, same invocation: live" live "$(stale "$live" inv-1 0 200)"
assert_eq "active, unit has a new invocation: stale" stale "$(stale "$live" inv-2 0 200)"
assert_eq "active, unit not active (empty id): stale" stale "$(stale "$live" "" 0 200)"
man='{"slot":1,"run_id":"manual-77-5","at":100,"state":"active","pid":77}'
assert_eq "manual run, pid alive: live" live "$(stale "$man" inv-9 1 200)"
assert_eq "manual run, pid gone: stale" stale "$(stale "$man" inv-9 0 200)"
done_c='{"slot":1,"run_id":"inv-1","at":100,"state":"done","until":1000}'
assert_eq "tombstone before until: live (holds the issue)" live "$(stale "$done_c" inv-2 0 999)"
assert_eq "tombstone at until: expired" stale "$(stale "$done_c" inv-2 0 1000)"
assert_eq "unparsable claim: stale" stale "$(stale 'not json' x 0 1)"

echo "take / release"
export FAKE_ACTIVE=active FAKE_INV=inv-A NOW=1000
K=1 RUN_ID=inv-A
assert_true "lane 1 takes #5" claim_take 5
assert_true "claim file written" test -s "$STATE/claims/5"
assert_eq "claim shape" '["at","pid","run_id","slot","state"]' "$(jq -c 'keys' "$STATE/claims/5")"
assert_true "taking it again in the same run is idempotent" claim_take 5
K=2 RUN_ID=inv-B
assert_false "lane 2 cannot take #5 while lane 1's unit runs inv-A" claim_take 5
assert_true "lane 2 takes #6" claim_take 6
# lane 1's unit restarted: its invocation id changed, so the old claim is stale
export FAKE_INV=inv-A2
K=2 RUN_ID=inv-B
assert_true "stale claim (new invocation of slot 1) can be taken over" claim_take 5
assert_eq "...and is now lane 2's" 2 "$(jq .slot "$STATE/claims/5")"

echo "live claims for the classifier"
export FAKE_INV=inv-B     # slot 1 and 2 share the fake id; both claims are 'live' for this test
rm -f "$STATE/claims/"*
K=1 RUN_ID=inv-B; claim_take 7
K=2 RUN_ID=inv-B; claim_take 8
assert_json_eq "claims_live_json" '[{"issue":7,"slot":1,"state":"active","until":null},{"issue":8,"slot":2,"state":"active","until":null}]' "$(claims_live_json)"

echo "release"
K=1 RUN_ID=inv-B
claim_release_run
assert_false "run release removes lane 1's claim" test -e "$STATE/claims/7"
assert_true "...and leaves lane 2's" test -e "$STATE/claims/8"
K=1 RUN_ID=other-run; claim_take 9
RUN_ID=inv-B claim_release_run
assert_true "a different run_id does not release (only this run's claims)" test -e "$STATE/claims/9"
claim_release_slot 1
assert_false "slot release (ExecStopPost) removes every claim of the slot" test -e "$STATE/claims/9"

echo "tombstone (A6)"
K=1 RUN_ID=inv-B
claim_take 10
claim_tombstone 10 900
assert_json_eq "tombstone: state done, until now+900" '{"slot":1,"state":"done","until":1900}' "$(jq -c '{slot,state,until}' "$STATE/claims/10")"
claim_release_run
assert_true "release_run keeps the tombstone" test -e "$STATE/claims/10"
K=2 RUN_ID=inv-C
assert_false "nobody can take a tombstoned issue" claim_take 10
export NOW=1900
assert_true "after until it can be taken again" claim_take 10
assert_json_eq "tombstone classified as done in claims_live_json before expiry" '[]' "$(rm -f "$STATE"/claims/*; echo '{"slot":1,"run_id":"x","at":1,"state":"done","until":5000}' > "$STATE/claims/11"; NOW=1900 claims_live_json | jq -c '[.[]|select(.issue!=11)]')"
claim_gc
assert_true "gc keeps a live tombstone" test -e "$STATE/claims/11"
NOW=6000 claim_gc
assert_false "gc removes an expired one" test -e "$STATE/claims/11"

echo "lock order (outer -> inner: merge, claim, mirror, stats/cooldown)"
assert_true "nothing held: anything goes" lock_order_ok "" merge
assert_true "merge then claim" lock_order_ok " merge" claim
assert_true "merge, claim, then mirror" lock_order_ok " merge claim" mirror
assert_true "mirror then stats" lock_order_ok " mirror" stats
assert_false "claim while holding mirror" lock_order_ok " mirror" claim
assert_false "merge while holding claim" lock_order_ok " claim" merge
assert_false "the same lock twice (would deadlock)" lock_order_ok " merge" merge
assert_false "stats then cooldown (siblings do not nest)" lock_order_ok " stats" cooldown
HELD_LOCKS=" mirror"
assert_eq "lk refuses an outer lock under an inner one" 99 "$(lk claim true; echo $?)"
HELD_LOCKS=""
assert_eq "lk runs a function under the lock" ran "$(f() { echo ran; }; lk stats f)"
finish
