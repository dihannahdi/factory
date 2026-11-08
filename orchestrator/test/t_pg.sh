#!/usr/bin/env bash
# The per-lane Postgres: started only when the server binaries exist, as its own unit in the
# lane's slice, on a unix socket; the URL reaches the sandbox (and nothing else does); any failure
# leaves the lane working without a database.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u
export FAKE_LOG=$T/fake.log FAKE_SYSTEMCTL_LOG=$T/systemctl.log FAKE_SYSTEMD_RUN_LOG=$T/sdrun.log
export SANDBOX=$TESTDIR/bin/fake-sandbox.sh
K=2 SLOTDIR=$H/s2 run=$T/log/x; mkdir -p "$SLOTDIR" "$run"
PG_WAIT=2
: > "$FAKE_LOG"; : > "$FAKE_SYSTEMCTL_LOG"; : > "$FAKE_SYSTEMD_RUN_LOG"

echo "no server binaries: no database, no failure"
PG_BIN=$T/nopg
pg_start; rc=$?
assert_eq "pg_start returns 0" 0 "$rc"
assert_eq "no URL" "" "${SB_PG_URL:-}"
assert_eq "nothing was started" 0 "$(wc -l < "$FAKE_SYSTEMD_RUN_LOG")"

echo "with binaries"
PG_BIN=$T/pg/bin; mkdir -p "$PG_BIN"; printf "#!/bin/sh
" > "$PG_BIN/initdb"; printf "#!/bin/sh
" > "$PG_BIN/postgres"; chmod +x "$PG_BIN/initdb" "$PG_BIN/postgres"
pg_start
assert_eq "URL: socket dir percent-encoded in the authority, no '/' after the host" "postgres://factory@$(printf '%s' "$SLOTDIR/pg" | sed 's|/|%2F|g')/postgres" "${SB_PG_URL:-}"
assert_true "initdb ran in the sandbox as part of the lane's dir" grep -q "initdb" "$FAKE_LOG"
unit=$(cat "$FAKE_SYSTEMD_RUN_LOG")
assert_true "own transient unit in the lane's slice, as factory" bash -c "grep -q -- '--unit=factory-pg-s2 --slice=factory-s2.slice --uid=factory' <<<'$unit'"
assert_true "unix socket only, in s2/pg" bash -c "grep -q -- \"-c listen_addresses= -c unix_socket_directories=$SLOTDIR/pg\" <<<'$unit'"
assert_true "no IP at all for the server" grep -q 'IPAddressDeny=any' <<<"$unit"
assert_true "the URL form survives the tests' own parsing (last '/' precedes the db name)" bash -c "u='$SB_PG_URL'; [[ \${u%/*}/postgres == \$u && \${u%/*} != *'?'* ]]"
assert_false "no host= query (it would put a '/' after the db name)" grep -q 'host=' <<<"$SB_PG_URL"
pg_stop
assert_true "stop: the unit is stopped" grep -q '^stop factory-pg-s2.service' "$FAKE_SYSTEMCTL_LOG"
assert_eq "stop: URL gone" "" "${SB_PG_URL:-}"

echo "pg_ensure: a server taken away mid-run is started again (3 Nov: factory-pg-s2 stopped, s3 killed)"
: > "$FAKE_SYSTEMD_RUN_LOG"; : > "$FAKE_SYSTEMCTL_LOG"
SB_PG_URL=
pg_ensure
assert_eq "no database in this run: pg_ensure starts nothing" 0 "$(wc -l < "$FAKE_SYSTEMD_RUN_LOG")"
pg_start; : > "$FAKE_SYSTEMD_RUN_LOG"
mkdir -p "$SLOTDIR/pg"; touch "$SLOTDIR/pg/.s.PGSQL.5432"
export FAKE_ACTIVE=active; pg_ensure
assert_eq "up and socket there: nothing restarted" 0 "$(wc -l < "$FAKE_SYSTEMD_RUN_LOG")"
url_before=$SB_PG_URL
export FAKE_ACTIVE=inactive; pg_ensure
assert_eq "unit gone (stopped or postmaster killed): a fresh server is started" 1 "$(grep -c -- '--unit=factory-pg-s2' "$FAKE_SYSTEMD_RUN_LOG")"
assert_eq "...and the URL is set again, same socket" "$url_before" "${SB_PG_URL:-}"
: > "$FAKE_SYSTEMD_RUN_LOG"
rm -f "$SLOTDIR/pg/.s.PGSQL.5432"
export FAKE_ACTIVE=active; pg_ensure
assert_eq "unit active but socket missing: restarted too" 1 "$(grep -c -- '--unit=factory-pg-s2' "$FAKE_SYSTEMD_RUN_LOG")"
assert_true "pg_sweep checks first (it runs before every turn and verify)" bash -c "sed -n '/^pg_sweep()/,/^}/p' '$ORCH/run.sh' | sed -n 2p | grep -qx '  pg_ensure'"
pg_stop; unset FAKE_ACTIVE

echo "failures leave the lane working"
: > "$FAKE_SYSTEMD_RUN_LOG"; FAKE_SYSTEMD_RUN_RC=1 pg_start; rc=$?
assert_eq "systemd-run fails: rc 0, no URL" "0|" "$rc|${SB_PG_URL:-}"
unset FAKE_SYSTEMD_RUN_RC
PG_ISREADY=sleepy_fail
fake_fail() { return 1; }
SANDBOX=$T/sb-fail; printf '#!/usr/bin/env bash\nexit 1\n' > "$SANDBOX"; chmod +x "$SANDBOX"
pg_start; rc=$?
assert_eq "initdb fails: rc 0, no URL" "0|" "$rc|${SB_PG_URL:-}"

echo "sandbox.sh passes the URL for this slot only"
sbx() { ( cd "$T"; SB_SLOT=$1 SB_PG_URL=$2 bash "$ORCH/sandbox.sh" /home/factory/s$1 60 true 2>&1 ); }
: > "$FAKE_SYSTEMD_RUN_LOG"
sbx 2 'postgres://factory@%2Fhome%2Ffactory%2Fs2%2Fpg/postgres' >/dev/null
assert_true "Environment=TEST_DATABASE_URL=... reaches the unit" grep -q 'Environment=TEST_DATABASE_URL=postgres://factory@%2Fhome%2Ffactory%2Fs2%2Fpg/postgres' "$FAKE_SYSTEMD_RUN_LOG"
: > "$FAKE_SYSTEMD_RUN_LOG"
out=$(sbx 2 'postgres://factory@%2Fhome%2Ffactory%2Fs1%2Fpg/postgres'); rc=$?
assert_true "another lane's socket is refused" grep -q 'refusing SB_PG_URL' <<<"$out"
out=$(sbx 2 'postgres://evil@127.0.0.1/postgres')
assert_true "a TCP URL is refused" grep -q 'refusing SB_PG_URL' <<<"$out"
assert_eq "nothing was run for the refused ones" 0 "$(wc -l < "$FAKE_SYSTEMD_RUN_LOG")"
: > "$FAKE_SYSTEMD_RUN_LOG"; sbx 2 '' >/dev/null
assert_false "without a database the variable is not set" grep -q TEST_DATABASE_URL "$FAKE_SYSTEMD_RUN_LOG"
echo "pg_sweep (leaked harness databases)"
SANDBOX=$TESTDIR/bin/fake-sandbox.sh
export FAKE_ACTIVE=active; mkdir -p "$SLOTDIR/pg"; touch "$SLOTDIR/pg/.s.PGSQL.5432"   # the server is up: pg_ensure stays quiet
: > "$FAKE_LOG"; SB_PG_URL="" PG_PSQL=/bin/true pg_sweep
assert_false "no lane database: nothing runs" grep -q pgsweep "$FAKE_LOG"
: > "$FAKE_LOG"; SB_PG_URL="postgres://factory@x/postgres" PG_PSQL=/bin/true pg_sweep
assert_true "with a lane database: one sweep in the sandbox" grep -q pgsweep "$FAKE_LOG"
assert_true "against this lane's socket" grep -q -- "$SLOTDIR/pg" "$FAKE_LOG"
assert_true "only harness databases are matched" grep -qF '^$3[a-z0-9_]+_[0-9a-f]{32}' "$FAKE_LOG"
assert_true "...with the default prefix test_" grep -qE '(^| )test_( |$)' "$FAKE_LOG"
: > "$FAKE_LOG"; PG_SWEEP_PREFIX=myapp_ SB_PG_URL="postgres://factory@x/postgres" PG_PSQL=/bin/true pg_sweep
assert_true "PG_SWEEP_PREFIX is passed on" grep -qE '(^| )myapp_( |$)' "$FAKE_LOG"
: > "$FAKE_LOG"; PG_SWEEP_PREFIX='x;y' SB_PG_URL="postgres://factory@x/postgres" PG_PSQL=/bin/true pg_sweep
assert_false "a prefix that is not [a-z0-9_]: no sweep at all" grep -q pgsweep "$FAKE_LOG"
: > "$FAKE_LOG"; PG_SWEEP_PREFIX= SB_PG_URL="postgres://factory@x/postgres" PG_PSQL=/bin/true pg_sweep
assert_false "an empty prefix switches the sweep off" grep -q pgsweep "$FAKE_LOG"

finish
