#!/usr/bin/env bash
# prompts/ must keep every contract the scripts parse or rely on (file names, the plan's json block,
# the .git/agent-* files, the review section run.sh appends) and stay generic: nothing that only
# fits one repo (no project names, no fixed source paths, no CR line endings).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
P_DIR=$ORCH/prompts

has() { grep -qF -- "$2" "$1"; }

echo "the four files exist, and nothing else"
for f in prompt review triage adopt; do assert_true "$f.md" test -s "$P_DIR/$f.md"; done
assert_eq "and nothing else is in the directory" "adopt.md prompt.md review.md triage.md" "$(ls "$P_DIR" | paste -sd' ' -)"

echo "contracts the scripts rely on"
for m in '.git/agent-checklist.json' '{"item": "...", "done": true|false, "evidence": "file:line and test name"}' \
         '.git/agent-pr-body.md' '.git/agent-blocked.md' '"Closes #..."' 'The working tree must be clean' 'Do not push' \
         'do not change the remote' 'Do not touch .github/, deploy/, or existing migration files'; do
  assert_true "prompt.md: $m" has "$P_DIR/prompt.md" "$m"
done
for m in 'git diff main...HEAD' '.git/agent-review.md' '"No findings."' '"Apply review findings"' '.git/agent-checklist.json' \
         'root verify result' 'do not touch .github/, deploy/, or existing migrations'; do
  assert_true "review.md: $m" has "$P_DIR/review.md" "$m"
done
# run.sh's verify digest is the section review.md points at: same words on both sides.
assert_true "run.sh prints the section review.md names" grep -qF -- '--- root verify result (already run, PASSED) ---' "$ORCH/run.sh"
assert_eq "triage.md: first line" "Step 1 of 2: PLAN. Do not change, create, or delete any file in this step." "$(head -n1 "$P_DIR/triage.md")"
for m in '"depends_on"' '"decision": "blocked"' 'End your answer with exactly one ```json block shaped like this:'; do
  assert_true "triage.md: $m" has "$P_DIR/triage.md" "$m"
done
assert_eq "adopt.md: first line" "Step 2 of 2, ADOPT VARIANT. The work below does not start from scratch: a human already worked on" "$(head -n1 "$P_DIR/adopt.md")"
assert_eq "adopt.md: ends on the line the general rules follow" "General rules of the BUILD step (they apply here too, except where replaced above):" "$(grep -v '^$' "$P_DIR/adopt.md" | tail -n1)"
for m in 'A. AUDIT first' 'B. BUILD only' "C. Keep the author's design" 'D. The output contract' '.git/agent-checklist.json' '.git/agent-pr-body.md'; do
  assert_true "adopt.md: $m" has "$P_DIR/adopt.md" "$m"
done
assert_eq "prompt.md: first line" "Step 2 of 2: BUILD your plan above, on your own. There is no human to ask until the PR is reviewed." "$(head -n1 "$P_DIR/prompt.md")"
assert_eq "review.md: first line" "You are an INDEPENDENT REVIEWER. The changes on this branch were written by another agent for the" "$(head -n1 "$P_DIR/review.md")"

echo "the plan's json block is what plan_step's parser reads (same jq as run.sh)"
# plan_step takes the last ```json block of the turn's text; the example in triage.md is that shape
plan=$(jq -Rs 'split("```json") | if length < 2 then empty else last | split("```") | first | try fromjson catch empty end' -c < "$P_DIR/triage.md")
assert_eq "triage.md: the example parses, with the keys run.sh reads" '["decision","files","reason","requirements","slice","tests"]' "$(jq -c 'keys' <<<"$plan" 2>/dev/null)"
assert_eq "triage.md: decision go" go "$(jq -r .decision <<<"$plan" 2>/dev/null)"

echo "run.sh joins them: adopt.md, then prompt.md"
joined=$(cat "$P_DIR/adopt.md" "$P_DIR/prompt.md")
grep -q 'General rules of the BUILD step' <<<"$joined" && grep -q '^Step 2 of 2: BUILD' <<<"$joined" && ok "the joined text still reads as one" || bad "joined text"

echo "generic: the repo's own rule files, both verify kinds, nothing project-specific"
for f in prompt review triage adopt; do
  for m in AGENTS.md CLAUDE.md CONTRIBUTING.md; do
    assert_true "$f.md names $m" has "$P_DIR/$f.md" "$m"
  done
  assert_false "$f.md: nothing project-specific" grep -Eqi 'crates/|ADR-[0-9]|physics|fisika|astro|tailwind|studio|frontend/src|example\.com|Bahasa' "$P_DIR/$f.md"
  assert_false "$f.md has no CR" grep -q $'\r' "$P_DIR/$f.md"
done
for f in prompt review; do
  assert_true "$f.md: cargo" has "$P_DIR/$f.md" 'cargo test'
  assert_true "$f.md: npm" has "$P_DIR/$f.md" 'npm test'
done
assert_true "prompt.md: no invented personal data" grep -q 'invent personal data that looks real' "$P_DIR/prompt.md"
assert_true "prompt.md: summary in English" has "$P_DIR/prompt.md" 'Write the PR summary in English'

finish
