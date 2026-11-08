#!/usr/bin/env bash
# Tests for FAIL_DETAIL: fail_lines, ci_digest, guard naming its files, and the fail_issue comment.
# No model, no GitHub: $GH and mg are stubs, and the log lines are real ones from failed CI jobs
# (a benchmark gate, a doctest, Playwright). usage: test-fail-detail.sh [run.sh] (default: the repo's;
# pass /opt/factory/run.sh to check a deployed copy)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN=${1:-$HERE/run.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
eval "$(sed -n '/^fail_lines()/,/^}/p;/^job_log()/,/^}/p;/^ci_log()/,/^}/p;/^ci_digest()/,/^}/p;/^guard()/,/^}/p;/^fail_issue()/,/^}/p' "$RUN")"
pass=0 fail=0
ok() { pass=$((pass+1)); printf 'PASS  %s\n' "$1"; }
no() { fail=$((fail+1)); printf 'FAIL  %s\n' "$1"; }
has() { if grep -qF -- "$3" <<<"$2"; then ok "$1"; else no "$1 (missing: $3)"; fi; }
hasnt() { if grep -qF -- "$3" <<<"$2"; then no "$1 (unexpected: $3)"; else ok "$1"; fi; }
eq() { if [[ $2 == "$3" ]]; then ok "$1 = $3"; else no "$1 (want $3, got $2)"; fi; }

TS='2026-10-27T01:50:12.4471234Z '
BENCH="${TS}warning: unused variable: \`layer\`
${TS}   --> crates/shop-geom/src/dxf.rs:181:11
${TS}     Running benches/simulate.rs (/opt/actions-runner/_cache/target/release/deps/simulate-79ee58b95f273375)
${TS}FAIL: fastest of 51 runs 55.348578ms >= 50ms
${TS}error: bench failed, to rerun pass \`-p shop-core --bench simulate\`
${TS}
${TS}simulate_1mwp: fastest of 51 runs 55.3 ms (limit 50 ms)
${TS}##[error]Process completed with exit code 1."
DOCTEST="${TS}   Doc-tests shop_api
${TS}error[E0463]: can't find crate for \`shop_core\`
${TS} --> crates/shop-api/src/consumption_store.rs:4:5
${TS}  |
${TS}4 | use shop_core::MonthlyConsumption;
${TS}error: aborting due to 1 previous error
${TS}error: doctest failed, to rerun pass \`-p shop-api --doc\`"
E2E="${TS}  ✘   98 [chromium] › e2e/lay06-geometry-editor.spec.ts:300:3 › lay06_geometry_editor › typing r in a name field does not rotate (1.1m)
${TS}  ✓   99 [chromium] › e2e/lay06-geometry-editor.spec.ts:320:3 › lay06_geometry_editor › snaps (2.0s)
${TS}  1) [chromium] › e2e/lay06-geometry-editor.spec.ts:311:3 › lay06_geometry_editor › midpoint insert, vertex drag and Alt-drag each add exactly one command
${TS}    Error: expect(received).toBe(expected) // Object.is equality"
VERIFY='### cargo test --workspace --locked
test design_temps::lookup_is_fast ... ok
test design_temps::lapse_rate_correction ... FAILED
---- design_temps::lapse_rate_correction stdout ----
thread '"'"'design_temps::lapse_rate_correction'"'"' panicked at crates/shop-core/src/design_temps.rs:88:9:
assertion `left == right` failed
  left: -3.7
 right: -3.705
test result: FAILED. 41 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
### FAILED: cargo test --workspace --locked'

echo "== (a) fail_lines on real CI lines"
out=$(fail_lines 20 <<<"$BENCH")
has "bench: FAIL line kept" "$out" "FAIL: fastest of 51 runs 55.348578ms >= 50ms"
has "bench: rerun hint kept" "$out" "error: bench failed, to rerun pass"
hasnt "bench: timestamp stripped" "$out" "2026-10-27T01:50"
hasnt "bench: ##[error] noise dropped" "$out" "##[error]"
hasnt "bench: a warning's location dropped" "$out" "dxf.rs:181"
out=$(fail_lines 20 <<<"$DOCTEST")
has "doctest: rustc error kept" "$out" "error[E0463]: can't find crate for \`shop_core\`"
has "doctest: location kept" "$out" " --> crates/shop-api/src/consumption_store.rs:4:5"
out=$(fail_lines 20 <<<"$E2E")
has "e2e: failed test kept" "$out" "✘   98 [chromium] › e2e/lay06-geometry-editor.spec.ts:300:3"
has "e2e: numbered failure kept" "$out" "1) [chromium] › e2e/lay06-geometry-editor.spec.ts:311:3"
has "e2e: Error line kept" "$out" "Error: expect(received).toBe(expected)"
hasnt "e2e: passing test dropped" "$out" "✓   99"

# PR #288 (#54), run 40986912651, 30 Oct: the instruction gate failed and fail_lines matched nothing,
# so the agent got the post-job cleanup tail instead.
GATE="${TS}test oracle::oracle_tolerances_config_loaded_and_active ... ok
${TS}simulate_1mwp instruction gate (ADR-0026): FAIL
${TS}  measured 2_138_753_380 Ir, baseline 1_961_236_635 Ir, change +9.051% (tolerance +1%)
${TS}  limit 1_980_849_001 Ir. The engine now executes more instructions for the same workload.
${TS}  If the increase is intended (new physics), raise the budget and say why:
${TS}    cargo xtask perf-gate --update --reason \"<which physics was added and why it costs this much>\"
${TS}  then commit crates/shop-core/benches/perf-budget.toml. The reviewer reads that reason.
${TS}  If it is not intended, find what made this code path do more work.
${TS}Temporarily overriding HOME='/opt/actions-runner/_work/_temp/x' before making global git config changes
${TS}##[error]the old lumped system factor reappeared
${TS}##[error]Process completed with exit code 1.
${TS}[command]/usr/bin/git config --local --unset-all http.https://github.com/.extraheader
${TS}Cleaning up orphan processes"
out=$(fail_lines 20 <<<"$GATE")
has "gate: verdict kept" "$out" "simulate_1mwp instruction gate (ADR-0026): FAIL"
has "gate: its numbers kept" "$out" "measured 2_138_753_380 Ir, baseline 1_961_236_635 Ir, change +9.051% (tolerance +1%)"
has "gate: the fix it names kept" "$out" "cargo xtask perf-gate --update --reason"
has "gate: the not-intended branch kept" "$out" "If it is not intended, find what made this code path do more work."
has "gate: a script's ::error:: kept" "$out" "##[error]the old lumped system factor reappeared"
hasnt "gate: exit-code noise dropped" "$out" "Process completed with exit code"
hasnt "gate: unindented line after verdict dropped" "$out" "Temporarily overriding HOME"
hasnt "gate: cleanup dropped" "$out" "Cleaning up orphan processes"

echo "== (b) fail_lines on a verify log"
out=$(fail_lines 40 <<<"$VERIFY")
has "verify: FAILED test" "$out" "test design_temps::lapse_rate_correction ... FAILED"
has "verify: stdout header" "$out" "---- design_temps::lapse_rate_correction stdout ----"
has "verify: panic location" "$out" "panicked at crates/shop-core/src/design_temps.rs:88:9"
has "verify: left value" "$out" "  left: -3.7"
has "verify: right value" "$out" " right: -3.705"
has "verify: step marker" "$out" "### FAILED: cargo test --workspace --locked"
hasnt "verify: passing test dropped" "$out" "lookup_is_fast"

echo "== (c) limits and fallbacks"
out=$(seq 1 40 | sed 's/^/line /' | fail_lines 20)
eq "no match: falls back to the last 15 lines" "$(wc -l <<<"$out" | tr -d ' ')" 15
has "  and they are the last ones" "$out" "line 40"
eq "empty input: empty output" "$(fail_lines 20 </dev/null)" ""
out=$(for i in $(seq 1 100); do echo "test t$i ... FAILED"; done | fail_lines 20)
eq "max is respected" "$(wc -l <<<"$out" | tr -d ' ')" 20
out=$(printf 'FAIL: x\nFAIL: x\nFAIL: y\n' | fail_lines 20)
eq "duplicates collapse" "$(wc -l <<<"$out" | tr -d ' ')" 2
out=$(printf 'FAIL: %0400d\n' 0 | fail_lines 20)
eq "long lines are cut at 300" "${#out}" 300
# Called bare (not in $(...)), so a non-zero return would abort this set -e script right here.
fail_lines 20 </dev/null >/dev/null; ok "returns 0 on empty input under set -euo pipefail"
seq 1 3 | fail_lines 2 >/dev/null; ok "returns 0 when head cuts the pipe under set -euo pipefail"

echo "== (d) ci_digest with a stub GitHub"
REPO=acme/shop
printf '%s\n' "$BENCH" > "$T/job-1.log"; printf '%s\n' "$DOCTEST" > "$T/job-2.log"
# Job 3 is a Playwright log as GitHub serves it: coloured. Real gh 2.102 prints nothing for a
# response with terminal escapes unless --allow-escape-sequences is given (the stub does the same),
# which is how every failed job's log came back empty until 3 Nov.
ESC=$'\x1b'
printf '%s\n' "${TS}  ${ESC}[31m✘   79 [chromium] › e2e/lay13e-shadow-height.spec.ts:175:3 › lay13e_shadow_height › imagery date${ESC}[39m" \
  "${TS}    Error: expect(received).toBe(expected) // Object.is equality" > "$T/job-3.log"
cat > "$T/gh" <<EOF
#!/usr/bin/env bash
allow=0 path=
for a in "\$@"; do case "\$a" in --allow-escape-sequences) allow=1 ;; repos/*) path=\$a ;; esac; done
emit() { if (( ! allow )) && grep -q \$'\\x1b' "\$1"; then echo "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway" >&2; else cat "\$1"; fi; }
case "\$path" in
  repos/*/commits/*/check-runs*) printf '1\tIntegration tests\n2\tRust build and test\n3\tFrontend build and e2e\n' ;;
  repos/*/actions/jobs/1/logs) emit "$T/job-1.log" ;;
  repos/*/actions/jobs/2/logs) emit "$T/job-2.log" ;;
  repos/*/actions/jobs/3/logs) emit "$T/job-3.log" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$T/gh"; GH=$T/gh
out=$(ci_digest abc123)
has "digest: job 1 header" "$out" "### Integration tests"
has "digest: job 1 line" "$out" "FAIL: fastest of 51 runs 55.348578ms >= 50ms"
has "digest: job 2 header" "$out" "### Rust build and test"
has "digest: job 2 line" "$out" "error[E0463]: can't find crate"
has "digest: coloured Playwright log is read (--allow-escape-sequences)" "$out" "✘   79 [chromium] › e2e/lay13e-shadow-height.spec.ts:175:3"
hasnt "digest: colour codes stripped" "$out" "$ESC"
out=$(ci_log abc123)
has "ci_log: coloured job log reaches the fix turn" "$out" "e2e/lay13e-shadow-height.spec.ts:175:3"
has "ci_log: job named" "$out" "### job 3 (Frontend build and e2e)"
hasnt "ci_log: colour codes stripped" "$out" "$ESC"
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/gh-down"; chmod +x "$T/gh-down"; GH=$T/gh-down
eq "digest: GitHub down gives empty, not an abort" "$(ci_digest abc123)" ""

echo "== (e) guard names the files it refused"
base=main
mg() { printf '%s\n' .github/workflows/validation.yml crates/shop-core/data/design_temperatures.csv; }
rc=0; out=$(guard HEAD) || rc=$?
eq "guard rc on .github" "$rc" 1
eq "guard message" "$out" "changes .github/ or deploy/ (.github/workflows/validation.yml)"
# guard's second call asks for changed migrations only; a stub that ignored the path filter
# would hand it lib.rs and report a migration change that is not there.
mg() { [[ " $* " == *" crates/shop-api/migrations "* ]] || printf '%s\n' crates/shop-core/src/lib.rs; }
rc=0; out=$(guard HEAD) || rc=$?
eq "guard rc on a clean branch" "$rc" 0
eq "guard silent on a clean branch" "$out" ""

echo "== (f) the fail_issue comment"
log() { :; }; stage_end() { :; }; record() { :; }
cat > "$T/gh-comment" <<EOF
#!/usr/bin/env bash
if [[ \$1 == issue && \$2 == comment ]]; then cat > "$T/comment.md"; fi
EOF
chmod +x "$T/gh-comment"; GH=$T/gh-comment
n=164 run=/var/log/factory/issue-164-s1 adopt_pr=""
FAIL_DETAIL=$(printf '### Integration tests\nFAIL: fastest of 51 runs 55.348578ms >= 50ms')
( fail_issue ci_failed "CI still fails (fail) after 2 fix rounds (PR #240 closed)" )
c=$(cat "$T/comment.md")
has "comment: reason first" "$c" "factory did not finish this issue: CI still fails (fail) after 2 fix rounds (PR #240 closed)"
has "comment: detail heading" "$c" "Failing lines (filtered from the log):"
has "comment: fenced detail" "$c" "$(printf '````\n### Integration tests')"
has "comment: the failing line" "$c" "FAIL: fastest of 51 runs 55.348578ms >= 50ms"
has "comment: log path still last" "$(tail -n 1 <<<"$c")" "Log: \`/var/log/factory/issue-164-s1\` on the host."
FAIL_DETAIL=""
( fail_issue no_commit "the agent produced no commit." )
c=$(cat "$T/comment.md")
hasnt "comment without detail: no heading" "$c" "Failing lines"
eq "comment without detail: unchanged format" "$(head -n 2 <<<"$c" | tr '\n' '|')" "factory did not finish this issue: the agent produced no commit.||"
FAIL_DETAIL=$(head -c 9000 /dev/zero | tr '\0' 'x')
( fail_issue ci_failed "r" )
eq "comment: detail capped at 6000 chars" "$(grep -o x "$T/comment.md" | wc -l | tr -d ' ')" 6000

echo
echo "$pass passed, $fail failed"
(( fail == 0 ))
