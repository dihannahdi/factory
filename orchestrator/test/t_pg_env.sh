#!/usr/bin/env bash
# PG_TEST_ENV: the variable that carries the lane's Postgres URL to the tests. Default
# TEST_DATABASE_URL (t_pg.sh covers that path); another name for another repo; empty means the
# instance has no database tests and no per-lane Postgres is started.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u
export FAKE_LOG=$T/fake.log FAKE_SYSTEMCTL_LOG=$T/systemctl.log FAKE_SYSTEMD_RUN_LOG=$T/sdrun.log
export SANDBOX=$TESTDIR/bin/fake-sandbox.sh
K=4 SLOTS="4 5" SLOTDIR=$H/s4 run=$T/log/x; mkdir -p "$SLOTDIR" "$run"
PG_WAIT=2
PG_BIN=$T/pg/bin; mkdir -p "$PG_BIN"; printf '#!/bin/sh\n' > "$PG_BIN/initdb"; printf '#!/bin/sh\n' > "$PG_BIN/postgres"; chmod +x "$PG_BIN/initdb" "$PG_BIN/postgres"
reset() { : > "$FAKE_LOG"; : > "$FAKE_SYSTEMCTL_LOG"; : > "$FAKE_SYSTEMD_RUN_LOG"; unset SB_PG_URL; }
URL4='postgres://factory@%2Fhome%2Ffactory%2Fs4%2Fpg/postgres'
sbx() {  # sbx <PG_TEST_ENV-or-@unset> <url>: sandbox.sh for slot 4, its systemd-run call goes to FAKE_SYSTEMD_RUN_LOG
  ( cd "$T"; if [[ $1 == @unset ]]; then unset PG_TEST_ENV; else export PG_TEST_ENV=$1; fi
    SLOTS="4 5" SB_SLOT=4 SB_PG_URL=$2 bash "$ORCH/sandbox.sh" /home/factory/s4 60 true 2>&1 )
}

echo "defaults"
assert_eq "run.sh default" TEST_DATABASE_URL "$(env -u PG_TEST_ENV bash -c 'source "$1"; echo "$PG_TEST_ENV"' _ "$ORCH/run.sh")"
assert_eq "run.sh keeps an empty value empty" "[]" "[$(PG_TEST_ENV= bash -c 'source "$1"; echo "$PG_TEST_ENV"' _ "$ORCH/run.sh")]"
assert_eq "run.sh takes another name" DATABASE_URL "$(PG_TEST_ENV=DATABASE_URL bash -c 'source "$1"; echo "$PG_TEST_ENV"' _ "$ORCH/run.sh")"

echo "PG_TEST_ENV empty: no per-lane Postgres at all"
reset; PG_TEST_ENV=""
pg_start; rc=$?
assert_eq "pg_start returns 0" 0 "$rc"
assert_eq "no URL" "" "${SB_PG_URL:-}"
assert_eq "no initdb, no sandbox call" 0 "$(wc -l < "$FAKE_LOG")"
assert_eq "no unit started" 0 "$(wc -l < "$FAKE_SYSTEMD_RUN_LOG")"
assert_eq "no systemctl call (nothing to stop either)" 0 "$(wc -l < "$FAKE_SYSTEMCTL_LOG")"

echo "PG_TEST_ENV=DATABASE_URL: the lane's server is started, the URL goes to the sandbox under that name"
reset; PG_TEST_ENV=DATABASE_URL
pg_start
assert_eq "URL set" "postgres://factory@$(printf '%s' "$SLOTDIR/pg" | sed 's|/|%2F|g')/postgres" "${SB_PG_URL:-}"
assert_true "unit factory-pg-s4 in factory-s4.slice" grep -q -- '--unit=factory-pg-s4 --slice=factory-s4.slice' "$FAKE_SYSTEMD_RUN_LOG"
pg_stop
reset
sbx DATABASE_URL "$URL4" >/dev/null
assert_true "Environment=DATABASE_URL=..." grep -q "Environment=DATABASE_URL=$URL4" "$FAKE_SYSTEMD_RUN_LOG"
assert_false "and not the default name" grep -q TEST_DATABASE_URL "$FAKE_SYSTEMD_RUN_LOG"

echo "sandbox.sh"
reset
sbx @unset "$URL4" >/dev/null
assert_true "unset: Environment=TEST_DATABASE_URL=... as before" grep -q "Environment=TEST_DATABASE_URL=$URL4" "$FAKE_SYSTEMD_RUN_LOG"
reset
out=$(sbx "" "$URL4"); rc=$?
assert_eq "empty: the sandbox still runs" 0 "$rc"
assert_false "empty: no database variable at all" grep -Eq 'DATABASE_URL|postgres://' "$FAKE_SYSTEMD_RUN_LOG"
reset
out=$(sbx DATABASE_URL 'postgres://factory@%2Fhome%2Ffactory%2Fs5%2Fpg/postgres'); rc=$?
assert_eq "another lane's socket is still refused under another name" 2 "$rc"
assert_true "...saying so" grep -q 'refusing SB_PG_URL' <<<"$out"
for bad in 'A B' 'A;B' '1A' 'A=B' '-x'; do
  reset; out=$(sbx "$bad" "$URL4"); rc=$?
  assert_eq "PG_TEST_ENV='$bad' is refused" 2 "$rc"
  assert_eq "...and nothing was run" 0 "$(wc -l < "$FAKE_SYSTEMD_RUN_LOG")"
done

echo "the CI-failure prompt"
orig='If the failing test needs Postgres: this sandbox has its own Postgres through TEST_DATABASE_URL (unix socket) while the lane runs, so run that test directly (cargo test -p <crate> <name>) to reproduce it. '
VERIFY_KIND=cargo PG_TEST_ENV=TEST_DATABASE_URL
assert_eq "cargo default: the sentence" "$orig" "$(pg_fix_hint)"
PG_TEST_ENV=""
assert_eq "no database: no sentence" "" "$(pg_fix_hint)"
VERIFY_KIND=node PG_TEST_ENV=DATABASE_URL
assert_eq "node with a database: its own variable and npm" 'If the failing test needs Postgres: this sandbox has its own Postgres through DATABASE_URL (unix socket) while the lane runs, so run that test directly (npm test -- <name>) to reproduce it. ' "$(pg_fix_hint)"
VERIFY_KIND=cargo PG_TEST_ENV=TEST_DATABASE_URL
msg="Fix the cause, not the symptom. $(pg_fix_hint)Run the build and tests, then commit."
assert_eq "the whole sentence pair, as run.sh writes it" "Fix the cause, not the symptom. ${orig}Run the build and tests, then commit." "$msg"
assert_true "run.sh writes that pair" grep -qF 'Fix the cause, not the symptom. $(pg_fix_hint)Run the build and tests, then commit.' "$ORCH/run.sh"
PG_TEST_ENV=""
assert_eq "without a database the prompt goes straight on" "Fix the cause, not the symptom. Run the build and tests, then commit." "Fix the cause, not the symptom. $(pg_fix_hint)Run the build and tests, then commit."

finish
