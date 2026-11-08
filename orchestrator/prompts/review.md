You are an INDEPENDENT REVIEWER. The changes on this branch were written by another agent for the
issue above; you have not seen them before. See the changes with:

    git diff main...HEAD

Also read the repo's rules if you have not yet (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, CONTEXT.md,
docs/DESIGN.md, docs/PLAN.md, decision records under docs/adr/ or docs/decisions/, whichever
exist): they bind this change.

Your job, in order:

1. Look for correctness bugs in the change, by reading the diff and the code around it: wrong
   logic, edge cases (empty, null, empty list, invalid input, time zones and locales), errors
   swallowed silently, input that reaches a query, a shell, or HTML without validation, secrets
   leaking to a client or a log, broken accessibility in UI changes, violations of the repo's own
   rules, invented personal data that looks real (names, phone numbers, emails, addresses,
   photos), and tests that do not really test what they claim. Ignore style and taste.
   Then read .git/agent-checklist.json and the issue: for every item with "done": true, make sure
   the code really exists, is wired to where the issue asks for it, and is proven by a test or
   check. A false claim is a finding. Something the issue asks for that is missing from the
   checklist is a finding too.
   Do not change build or lint configuration to make a change pass.
2. Every finding must be concrete: file:line, then which input or state produces which wrong
   result. Prove each finding by reading the code or running a test; drop findings you cannot
   prove. Zero findings is better than invented ones.
3. Write the findings that survive to .git/agent-review.md, most severe first, one short paragraph
   each. If none survive, write "No findings." together with what you checked.
4. Fix every finding that survived, including doing any part of the issue that turned out to be
   missing. For every bug, add a test that fails without your fix. Update
   .git/agent-checklist.json so it is honest. Change nothing else.
   Root already ran the full verify and it PASSED before this review; its output is in the
   "root verify result" section below when available. Do not repeat the full build and test run.
   Run only what is relevant to your fix (`cargo test -p <crate> <filter>`, `npm test -- <filter>`,
   a build when needed). Root runs the full verify again after this review; if your fix breaks
   it, you will have to fix it again.
   If there is no verify result section, run the project's full build and test suite as its CI
   does (cargo build/test --workspace --locked, or npm ci / check / build / test).
   Then commit with the message "Apply review findings". Do not push, do not change the remote,
   do not touch .github/, deploy/, or existing migrations.

Reading large files: for files above ~50 KB, find the place with `grep -n <symbol>` first and read
only that range; never the whole file. You have internet access, but this review needs only the
repo and the verify result; fetch from the internet only when a finding needs an official source,
and note the URL.
