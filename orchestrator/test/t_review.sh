#!/usr/bin/env bash
# Review scope: root's verify result reaches the review turn; review.md no longer asks for the
# full test suite and keeps its output contract.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/run.sh"
set +e
set +u
PROMPTS=$ORCH/prompts

cat > "$T/verify.log" <<'L'
### cargo test --workspace --locked
test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 1.2s
test result: ok. 30 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 51s
L
d=$(verify_digest "$T/verify.log" deadbeefcafe1234)
assert_true "digest: 42 passed, 0 failed, 1 ignored" grep -q '42 passed, 0 failed, 1 ignored' <<<"$d"
assert_true "digest: says PASSED and the head" bash -c "grep -q PASSED <<<'$d' && grep -q deadbeefcafe <<<'$d'"
assert_true "digest: carries the log tail" grep -q 'finished in 51s' <<<"$d"
SB_PG_URL=x; assert_true "digest: Postgres yes" grep -q 'Postgres for DB tests: yes' <<<"$(verify_digest "$T/verify.log" abc)"; SB_PG_URL=

# review_branch hands the digest to the review turn
run=$T/log/x; mkdir -p "$run"; issue_text="ISSUE"; sid=ses_author; verified_head=h1
sb() { case $* in *"rev-parse HEAD"*) echo h1 ;; *status*) ;; *) true ;; esac; }
agent() { printf '%s' "$3" > "$T/review.msg"; }
fix_loop() { return 0; }
VERIFY_DIGEST=$d
review_branch
assert_true "review turn: issue text, review.md, and the verify digest" bash -c "grep -q ISSUE '$T/review.msg' && grep -q 'REVIEWER' '$T/review.msg' && grep -q 'root verify result' '$T/review.msg'"
assert_eq "the author's session is restored after the review" ses_author "$sid"
VERIFY_DIGEST=""
review_branch
assert_false "no digest (shepherd path): the section is absent" grep -q 'root verify result (already' "$T/review.msg"

r=$ORCH/prompts/review.md
assert_true "review.md: relevant tests only" grep -q 'cargo test -p <crate> <filter>' "$r"
assert_true "review.md: big files via grep -n" grep -q 'grep -n' "$r"
assert_true "review.md: internet stated truthfully" grep -q 'You have internet access' "$r"
assert_true "review.md: output contract intact (agent-review.md, checklist, commit message)" bash -c "grep -q '.git/agent-review.md' '$r' && grep -q 'agent-checklist.json' '$r' && grep -q 'Apply review findings' '$r'"
finish
