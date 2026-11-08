#!/usr/bin/env bash
# A second instance (SLOTS, lane position, AGENT_UNIT). The defaults must be today's behaviour
# exactly: slots 1 2 3, lane position = slot number, units named factory@N.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u
export FAKE_SYSTEMD_RUN_LOG=$T/sdrun.log
: > "$FAKE_SYSTEMD_RUN_LOG"

yn() { "$@" && echo yes || echo no; }

echo "SLOTS unset: the first instance's lanes, as before"
assert_eq "lib.sh default" "1 2 3" "$(env -u SLOTS bash -c 'source "$1"; echo "$SLOTS"' _ "$ORCH/lib.sh")"
assert_eq "lib.sh default unit" "factory" "$(env -u AGENT_UNIT bash -c 'source "$1"; echo "$AGENT_UNIT"' _ "$ORCH/lib.sh")"
unset SLOTS; SLOTS=${SLOTS:-1 2 3}
for k in 1 2 3; do assert_eq "slot $k valid" yes "$(yn slot_valid $k)"; done
for k in 0 4 5 9 01 "" "1 2" a; do assert_eq "slot '$k' not valid" no "$(yn slot_valid "$k")"; done
for k in 1 2 3; do assert_eq "slot $k is lane $k" "$k" "$(slot_index $k)"; done
assert_eq "slot_index of a stranger fails" no "$(yn slot_index 4)"

echo "SLOTS=\"4 5\": the blog lanes"
SLOTS="4 5"
assert_eq "slot 4 valid" yes "$(yn slot_valid 4)"
assert_eq "slot 5 valid" yes "$(yn slot_valid 5)"
for k in 1 2 3 9 6 04; do assert_eq "slot $k not valid" no "$(yn slot_valid $k)"; done
assert_eq "slot 4 is lane 1" 1 "$(slot_index 4)"
assert_eq "slot 5 is lane 2" 2 "$(slot_index 5)"

echo "refresh_effective compares the lane position with control.agents"
# The real disk must not decide (effective_agents_calc drops to one lane below DISK_ONE_GB).
export DISK_STOP_GB=0 DISK_ONE_GB=0
printf '%s\n' '{"v":1,"agents":1,"models":["opencode/a-free"]}' > "$CTL/control.json"
K=4; refresh_effective; assert_eq "agents 1: slot 4 (lane 1) works" "0|1" "$DRAIN|$ST_EFF"
K=5; refresh_effective; assert_eq "agents 1: slot 5 (lane 2) drains" "1|1" "$DRAIN|$ST_EFF"
printf '%s\n' '{"v":1,"agents":2,"models":["opencode/a-free"]}' > "$CTL/control.json"
K=5; refresh_effective; assert_eq "agents 2: slot 5 works" 0 "$DRAIN"
printf '%s\n' '{"v":1,"agents":0,"models":["opencode/a-free"]}' > "$CTL/control.json"
K=4; refresh_effective; assert_eq "agents 0: slot 4 drains" 1 "$DRAIN"
SLOTS="1 2 3"
printf '%s\n' '{"v":1,"agents":2,"models":["opencode/a-free"]}' > "$CTL/control.json"
K=2; refresh_effective; assert_eq "defaults, agents 2: lane 2 works" 0 "$DRAIN"
K=3; refresh_effective; assert_eq "defaults, agents 2: lane 3 drains" 1 "$DRAIN"
K=""; assert_eq "no slot yet: position 0, as K > n was" 0 "$(lane_pos)"

echo "run.sh refuses a slot that is not the instance's"
for s in "1 2 3|4" "4 5|1" "4 5|9" "1 2 3|0"; do
  out=$(SLOTS=${s%%|*} bash "$ORCH/run.sh" --slot "${s##*|}" 2>&1); rc=$?
  assert_eq "SLOTS='${s%%|*}': --slot ${s##*|} refused with 2" 2 "$rc"
  assert_true "...and says which slots are valid" grep -q "slot must be one of: ${s%%|*}" <<<"$out"
done
SLOTS=${SLOTS:-} bash "$ORCH/run.sh" --cleanup 7 >/dev/null 2>&1; assert_eq "--cleanup 7 refused" 2 "$?"
SLOTS="4 5" bash "$ORCH/run.sh" --cleanup 1 >/dev/null 2>&1; assert_eq "--cleanup 1 refused under SLOTS 4 5" 2 "$?"

echo "claims: a lane proves itself through AGENT_UNIT@slot"
# The systemctl stub answers `show` for any unit; FAKE_SYSTEMCTL_SHOW_LOG records which unit was asked.
export FAKE_SYSTEMCTL_SHOW_LOG=$T/show.log FAKE_ACTIVE=active FAKE_INV=inv-J
printf '%s\n' '{"slot":4,"run_id":"inv-J","at":100,"state":"active"}' > "$T/c4"
printf '%s\n' '{"slot":2,"run_id":"inv-J","at":100,"state":"active"}' > "$T/c2"
: > "$T/show.log"
SLOTS="4 5" AGENT_UNIT=blog-agent claim_stale_file "$T/c4"
assert_eq "slot 4's active unit holds the claim: not stale" 1 "$?"
assert_true "it asked blog-agent@4.service" grep -q 'blog-agent@4.service' "$T/show.log"
assert_false "and never factory@4" grep -q 'factory@' "$T/show.log"
: > "$T/show.log"
SLOTS="1 2 3" AGENT_UNIT=factory claim_stale_file "$T/c2"
assert_eq "defaults: slot 2's claim is held by its unit" 1 "$?"
assert_true "it asked factory@2.service" grep -q 'factory@2.service' "$T/show.log"
: > "$T/show.log"
SLOTS="1 2 3" AGENT_UNIT=factory claim_stale_file "$T/c4"
assert_eq "a claim of slot 4 under the default SLOTS has no unit to prove it: stale" 0 "$?"
assert_eq "...and no unit was asked" 0 "$(wc -l < "$T/show.log")"
unset FAKE_SYSTEMCTL_SHOW_LOG FAKE_ACTIVE FAKE_INV

echo "sandbox.sh"
sbx() {  # sbx <SLOTS> <slot> [workdir-slot]
  ( cd "$T"; SB_HIDE_EXTRA="-/etc/blog-agent" SLOTS=$1 SB_SLOT=$2 bash "$ORCH/sandbox.sh" /home/factory/s${3:-$2} 60 true 2>&1 )
}
: > "$FAKE_SYSTEMD_RUN_LOG"
sbx "4 5" 4 >/dev/null; rc=$?
assert_eq "slot 4 under SLOTS 4 5 runs" 0 "$rc"
assert_true "in factory-s4.slice" grep -q -- '--slice=factory-s4.slice' "$FAKE_SYSTEMD_RUN_LOG"
assert_true "unit named factory-sb-4-" grep -q -- '--unit=factory-sb-4-' "$FAKE_SYSTEMD_RUN_LOG"
assert_true "its own directory is bound" grep -q 'BindPaths=.*/home/factory/s4' "$FAKE_SYSTEMD_RUN_LOG"
assert_true "/etc/blog-agent is hidden next to /etc/factory" grep -q 'InaccessiblePaths=/etc/factory -/etc/blog-agent ' "$FAKE_SYSTEMD_RUN_LOG"
: > "$FAKE_SYSTEMD_RUN_LOG"
out=$(sbx "4 5" 1); rc=$?
assert_eq "slot 1 under SLOTS 4 5 refused" 2 "$rc"
assert_true "...with the list of slots" grep -q 'SB_SLOT must be one of: 4 5' <<<"$out"
out=$(sbx "1 2 3" 4); assert_eq "slot 4 under the default refused" 2 "$?"
out=$(sbx "" 3 ); assert_eq "empty SLOTS means the default: slot 3 runs" 0 "$?"
out=$(sbx "4 5" 4 5); assert_eq "slot 4 may not work in s5" 2 "$?"
out=$(sbx "1 2 9" 9); assert_eq "SLOTS naming 9 is refused (reserved for gates)" 2 "$?"
assert_true "...as a bad entry" grep -q "bad SLOTS entry '9'" <<<"$out"
out=$(sbx "4 ../x" 4); assert_eq "SLOTS with a path in it is refused" 2 "$?"
: > "$FAKE_SYSTEMD_RUN_LOG"
( cd "$T"; SB_GATE=1 SLOTS="4 5" SB_SLOT=9 bash "$ORCH/sandbox.sh" /home/factory/s9 60 true >/dev/null 2>&1 ); assert_eq "gate lane 9 still works with SB_GATE=1" 0 "$?"
( cd "$T"; SLOTS="4 5" SB_SLOT=9 bash "$ORCH/sandbox.sh" /home/factory/s9 60 true >/dev/null 2>&1 ); assert_eq "...and only then" 2 "$?"

echo "the site named in messages comes from HEALTH_URL"
assert_eq "default" shop.example.com "$(HEALTH_URL=https://shop.example.com/api/health health_host)"
assert_eq "blog" blog.example.com "$(HEALTH_URL=https://blog.example.com/api/health health_host)"
assert_eq "with a port" localhost:4321 "$(HEALTH_URL=http://localhost:4321/health health_host)"
assert_eq "without a path" example.org "$(HEALTH_URL=https://example.org health_host)"
assert_eq "with a query" example.org "$(HEALTH_URL='https://example.org?x=1' health_host)"
assert_eq "lib.sh: no HEALTH_URL by default (no deploy watch)" "" "$(env -u HEALTH_URL bash -c 'source "$1"; echo "$HEALTH_URL"' _ "$ORCH/lib.sh")"
assert_false "no message in run.sh hard-codes the host any more" bash -c "grep -v '^[[:space:]]*#' '$ORCH/run.sh' | grep -q shop.example.com"

echo "MIGRATIONS_DIR: the dir existing migrations may not be edited in"
export FAKE_LOG=$T/fake.log
mg() { printf '%s\n' "$*" >> "$T/mg.log"; echo changed-file; }
: > "$T/mg.log"
guard feature >/dev/null; rc=$?
assert_eq "guard: a change under the default dir is refused" 1 "$rc"
assert_true "guard looked at migrations/" grep -q -- '-- migrations$' "$T/mg.log"
: > "$T/mg.log"; MIGRATIONS_DIR=db/migrations guard feature >/dev/null; rc=$?
assert_eq "guard with db/migrations: refused" 1 "$rc"
assert_true "guard looked at db/migrations" grep -q -- '-- db/migrations$' "$T/mg.log"
assert_false "and not at the default dir" grep -q -- '-- migrations$' "$T/mg.log"
: > "$FAKE_LOG"; SANDBOX=$TESTDIR/bin/fake-sandbox.sh pre_export_guards
assert_true "pre_export_guards: default dir" grep -qE -- '-- migrations( |$)' "$FAKE_LOG"
: > "$FAKE_LOG"; MIGRATIONS_DIR=db/migrations SANDBOX=$TESTDIR/bin/fake-sandbox.sh pre_export_guards
assert_true "pre_export_guards: db/migrations" grep -q -- '-- db/migrations' "$FAKE_LOG"
assert_false "pre_export_guards: not the default dir when set" grep -qE -- '-- migrations( |$)' "$FAKE_LOG"
assert_eq "run.sh default" migrations "$(env -u MIGRATIONS_DIR bash -c 'source "$1"; echo "$MIGRATIONS_DIR"' _ "$ORCH/run.sh")"
assert_eq "an empty value means the default" migrations "$(MIGRATIONS_DIR= bash -c 'source "$1"; echo "$MIGRATIONS_DIR"' _ "$ORCH/run.sh")"
unset -f mg

echo "target_trim on a lane with no cargo target (a Node instance)"
K=4 SLOTDIR=$H/s4; mkdir -p "$SLOTDIR/work/node_modules"; echo x > "$SLOTDIR/work/node_modules/f"
log() { echo "$*" >> "$T/log.out"; }; : > "$T/log.out"
TARGET_MAX_GB=0 target_trim; rc=$?
assert_eq "returns 0" 0 "$rc"
assert_false "does not create a target dir" test -e "$SLOTDIR/target"
assert_eq "says nothing" 0 "$(wc -l < "$T/log.out")"
assert_true "leaves the checkout alone" test -s "$SLOTDIR/work/node_modules/f"
mkdir -p "$SLOTDIR/target"; TARGET_MAX_GB=5 target_trim
assert_eq "an empty target under the limit: nothing logged" 0 "$(wc -l < "$T/log.out")"
rm -rf "$SLOTDIR/target"; ln -s "$T" "$SLOTDIR/target"; TARGET_MAX_GB=0 target_trim
assert_eq "a symlink named target is not followed" 0 "$(wc -l < "$T/log.out")"
rm -f "$SLOTDIR/target"
unset -f log

echo "AGENT_CRED: no credential reaches a model turn unless one is configured"
assert_eq "default is empty" "[]" "[$(env -u AGENT_CRED bash -c 'source "$1"; echo "$AGENT_CRED"' _ "$ORCH/run.sh")]"
assert_eq "empty stays empty" "[]" "[$(AGENT_CRED= bash -c 'source "$1"; echo "$AGENT_CRED"' _ "$ORCH/run.sh")]"
export FAKE_LOG=$T/fake.log FAKE_CRED_LOG=$T/cred.log FAKE_SYSTEMCTL_LOG=$T/systemctl.log
K=4 RUN_ID=r4 SLOTDIR=$H/s4 WORK=$H/s4/work OUT=$H/s4/out; mkdir -p "$WORK" "$STATE/locks"
ST_RUN=r4 ST_STATE=running ISB_KIND=verify
echo key > "$T/cds.key"
: > "$FAKE_CRED_LOG"; AGENT_CRED="cds:$T/cds.key" SANDBOX=$TESTDIR/bin/fake-sandbox.sh isb 60 sleepy >/dev/null
assert_eq "with the credential set and its file there: handed to the unit" "cds:$T/cds.key" "$(head -n1 "$FAKE_CRED_LOG")"
: > "$FAKE_CRED_LOG"; AGENT_CRED="" SANDBOX=$TESTDIR/bin/fake-sandbox.sh isb 60 sleepy >/dev/null
assert_eq "AGENT_CRED empty: no credential at all" "" "$(head -n1 "$FAKE_CRED_LOG")"
unset FAKE_CRED_LOG

finish
