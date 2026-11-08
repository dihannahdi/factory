#!/usr/bin/env bash
# VERIFY_KIND (cargo | node): the steps verify runs and what the PR and the reviewer are told about them.
# The node steps are run for real by a sandbox stand-in, with npm/node/npx/git as exported shell
# functions, so which steps run for which package.json is tested, not just which text is in the script.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u

export FAKE_LOG=$T/fake.log FAKE_SYSTEMCTL_LOG=$T/systemctl.log FAKE_NET_LOG=$T/net.log
export DISK_STOP_GB=0 DISK_ONE_GB=0
K=4 SLOTS="4 5" RUN_ID=run-AAA SLOTDIR=$H/s4 WORK=$H/s4/work OUT=$H/s4/out
mkdir -p "$WORK" "$STATE/claims" "$STATE/locks" "$STATE/cooldown"
run=$T/log/issue-5-x-s4; mkdir -p "$run"
ST_RUN=$RUN_ID n=5 base=deadbeef ST_STATE=running ISB_KIND=turn
export PROMPTS=$ORCH/prompts GH_TOKEN_FILE=$T/token

# A sandbox that runs the command for real (no systemd): workdir and timeout are dropped.
cat > "$T/sb-run.sh" <<'EOF'
#!/usr/bin/env bash
shift 2
if [[ -n ${SB_PRIVATE_NET:-} ]]; then echo "net: $(printf "%s " "$@" | tr "\n" " ")" >> "$FAKE_NET_LOG"; fi
"$@"
EOF
chmod +x "$T/sb-run.sh"
npm() { echo "[npm] $*"; if [[ -n ${FAKE_NPM_FAIL:-} && $* == *"$FAKE_NPM_FAIL"* ]]; then return 1; fi; return 0; }
npx() { echo "[npx] $*"; }
node() { [[ " ${FAKE_SCRIPTS:-} " == *" $3 "* ]]; }   # node -e <js> <script>: does package.json have it
git() { return 0; }                                    # a clean work tree, nothing changed
export -f npm npx node git

run_verify() {  # run_verify <scripts> [npm-fail-substring]: sets VLOG (file) and VRC
  FAKE_SCRIPTS=$1 FAKE_NPM_FAIL=${2:-}; export FAKE_SCRIPTS FAKE_NPM_FAIL
  : > "$FAKE_NET_LOG"; VLOG=$T/verify.log
  SANDBOX=$T/sb-run.sh verify > "$VLOG" 2>&1; VRC=$?
}
has() { grep -qxF -- "$1" "$VLOG"; }

echo "defaults"
assert_eq "run.sh default is cargo" cargo "$(env -u VERIFY_KIND bash -c 'source "$1"; echo "$VERIFY_KIND"' _ "$ORCH/run.sh")"
assert_eq "an empty value means the default too" cargo "$(VERIFY_KIND= bash -c 'source "$1"; echo "$VERIFY_KIND"' _ "$ORCH/run.sh")"

echo "node: a project with check, build, test and e2e scripts"
VERIFY_KIND=node
run_verify "check build test e2e"
assert_eq "verify passes" 0 "$VRC"
order=$(grep '^### ' "$VLOG" | paste -sd'|' -)
assert_eq "steps, in order" "### npm ci --no-audit --no-fund|### npm run check --if-present|### npm run build|### npm test --if-present|### npx playwright install chromium|### CI=1 npm run e2e" "$order"
assert_eq "e2e ran in the private-network call, and only that call had it" 1 "$(grep -c 'CI=1 npm run e2e' "$FAKE_NET_LOG")"
assert_eq "...exactly one such call" 1 "$(wc -l < "$FAKE_NET_LOG")"
assert_false "nothing cargo, no extra script, no frontend/ directory" grep -Eq 'cargo|verify-extra|frontend' "$VLOG"

echo "node: only a build script (no check, no test, no e2e)"
run_verify "build"
assert_eq "verify passes" 0 "$VRC"
assert_true "check said to be skipped" has "### skipped: npm run check (package.json has no check script)"
assert_true "test said to be skipped" has "### skipped: npm run test (package.json has no test script)"
assert_true "build ran" has "### npm run build"
assert_false "no browser download without an e2e script" grep -q playwright "$VLOG"
assert_eq "no private-network call without an e2e script" 0 "$(wc -l < "$FAKE_NET_LOG")"

echo "node: the first failing step ends the chain"
run_verify "check build test e2e" "run build"
assert_true "verify fails" test "$VRC" -ne 0
assert_true "the failure is marked" has "### FAILED: npm run build"
assert_false "npm test never ran" grep -q 'npm test' "$VLOG"
assert_eq "no e2e after a failed verify" 0 "$(wc -l < "$FAKE_NET_LOG")"
run_verify "build" "ci"
assert_true "npm ci failing fails verify" test "$VRC" -ne 0
assert_false "and nothing runs after it" grep -q 'npm run build' "$VLOG"

echo "node: what the reviewer and the PR are told is what ran"
run_verify "check build test e2e"; cp "$VLOG" "$run/verify-build-1.log"
d=$(verify_digest "$VLOG" 0123456789abcdef)
assert_true "digest lists the steps that ran" grep -qF 'HEAD 0123456789ab: npm ci, npm run check, npm run build, npm test, download Chromium, Playwright (npm run e2e). Last 25 lines' <<<"$d"
assert_false "no cargo, ADR or Postgres wording" grep -Eqi 'cargo|ADR|postgres' <<<"$d"
assert_true "still carries the log tail" grep -q '^### npm run build' <<<"$d"
run_verify "build"; cp "$VLOG" "$run/verify-build-2.log"; touch -d '1 minute ago' "$run/verify-build-1.log"
d=$(verify_digest "$VLOG" 0123456789abcdef)
assert_true "digest of a project without check/test says so" grep -qF 'npm ci, npm run build (skipped, package.json has no script for: npm run check, npm run test)' <<<"$d"
note=$(pr_verify_note_node)
assert_true "PR note describes the newest verify log" grep -qF 'The sandbox ran: npm ci, npm run build (skipped' <<<"$note"
assert_false "PR note: no cargo, ADR or Playwright when e2e did not run" grep -Eqi 'cargo|ADR|playwright' <<<"$note"
assert_true "PR note: CI is still the merge gate" grep -q 'CI on GitHub' <<<"$note"
rm -f "$run"/verify-*.log
note=$(pr_verify_note_node)
assert_true "no verify log in this run: says so, claims no steps" grep -q 'was recorded' <<<"$note"

echo "the PR body carries the note of its kind"
used=(deepseek) ST_TOK_IN=1 ST_TOK_OUT=2 ST_TOK_CACHE=3 RUN_COST=0 STEER_QUOTES=() plan="" review_text="ok"
run_verify "build"; cp "$VLOG" "$run/verify-build-1.log"
body=$(SANDBOX=$T/sb-run.sh pr_body_common '[]' 2>&1)
assert_true "node: the note in the body" grep -q 'The sandbox ran: npm ci, npm run build' <<<"$body"
assert_false "node: no verify-extra / cargo / frontend/ line" grep -Eq 'verify-extra|cargo|frontend/' <<<"$body"
VERIFY_KIND=cargo
body=$(SANDBOX=$T/sb-run.sh pr_body_common '[]' 2>&1)
assert_true "cargo: the cargo line" grep -qF 'The sandbox ran scripts/verify-extra.sh (if present), `cargo build`, `cargo test` without Postgres (DB tests skipped), and the' <<<"$body"
assert_true "cargo: Playwright is a gate by default" grep -qF 'CI runs its own checks too, and all of them are required before merge.' <<<"$body"
body=$(PLAYWRIGHT_GATE_AFTER=190 SANDBOX=$T/sb-run.sh pr_body_common '[]' 2>&1)
assert_true "cargo: with PLAYWRIGHT_GATE_AFTER open, Playwright is not a gate yet" grep -qF 'Playwright in CI is not required before merge yet (until #190 is done).' <<<"$body"
rm -f "$run"/verify-*.log

echo "an unknown VERIFY_KIND stops the lane before it does anything"
out=$(VERIFY_KIND=nodejs SLOTS="4 5" bash "$ORCH/run.sh" --slot 4 2>&1); rc=$?
assert_eq "refused with 2" 2 "$rc"
assert_true "and says what is valid" grep -q 'VERIFY_KIND must be cargo or node' <<<"$out"
out=$(VERIFY_KIND=cargo bash "$ORCH/run.sh" --slot 7 2>&1); assert_eq "cargo passes this check (then fails the slot one)" 2 "$?"
assert_true "...on the slot, not the kind" grep -q 'slot must be one of' <<<"$out"

echo "cargo: verify and the review contract are pinned"
unset -f npm npx node git
: > "$FAKE_LOG"
SANDBOX=$TESTDIR/bin/fake-sandbox.sh verify >/dev/null 2>&1
# golden/cargo-verify.txt pins the whole cargo verify script as handed to the sandbox, and the review
# turn's contract. It guards against an edit made for one kind (node) silently changing what the
# cargo kind runs or promises the reviewer. Changing it on purpose: regenerate the file from this
# test's $got and say why in the commit.
got=$(echo "=== verify"; sed -E 's/unit=factory-sb-[0-9]+-[0-9]+-[0-9]+/unit=U/' "$FAKE_LOG"; echo "=== review contract"; phase_contract review; echo)
if [[ -n ${REGEN_GOLDEN:-} ]]; then printf '%s\n' "$got" > "$TESTDIR/golden/cargo-verify.txt"; fi
assert_eq "verify script and review contract identical to the pinned ones" "$(cat "$TESTDIR/golden/cargo-verify.txt")" "$got"
assert_false "no node -e probe of package.json" grep -q 'process.exit' "$FAKE_LOG"
d=$(verify_digest "$T/none.log" 0123456789abcdef)
assert_true "digest wording unchanged" grep -qF 'HEAD 0123456789ab: scripts/verify-extra.sh if present, cargo build --workspace, cargo test --workspace (0 passed, 0 failed, 0 ignored; Postgres for DB tests: no),' <<<"$d"

echo "contracts and prompts that name the test command"
assert_true "cargo review contract: cargo test -p <crate> <filter>" grep -qF '(cargo test -p <crate> <filter>; the full verify passed before the review' <<<"$(phase_contract review)"
VERIFY_KIND=node
c=$(phase_contract fix-review-1)
assert_true "node review contract: npm" grep -qF '(npm run build, or npm test -- <filter> when there is a test script; the full verify passed' <<<"$c"
assert_false "node review contract: no cargo" grep -q cargo <<<"$c"
assert_true "node keeps the commit message contract" grep -qF 'then commit with the message "Apply review findings".' <<<"$c"
ctx=$(sb() { :; }; adopt_context 7 br t)
assert_true "node adopt context names the design docs" grep -qF 'breaks the issue or docs/DESIGN.md or docs/PLAN.md.' <<<"$ctx"
VERIFY_KIND=cargo
ctx=$(sb() { :; }; adopt_context 7 br t)
assert_true "cargo adopt context names design decisions" grep -qF 'breaks the issue or a written design decision (ADR).' <<<"$ctx"

finish
