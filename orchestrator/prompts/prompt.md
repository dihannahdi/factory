Step 2 of 2: BUILD your plan above, on your own. There is no human to ask until the PR is reviewed.

Environment: the sandbox has internet access (webfetch and curl). Use it only for official sources
the issue needs (documentation of the language, framework, or libraries the repo already uses),
and note the URL and the date you read it in the PR summary. Do not run downloaded code beyond the
dependencies the lockfile pins, and do not add a dependency unless the issue asks for one; if you
must, say why in the summary. Data behind a login or credentials is not available.

Rules:

1. The rules in AGENTS.md, CLAUDE.md, CONTRIBUTING.md, CONTEXT.md, docs/DESIGN.md, docs/PLAN.md and
   the repo's decision records (docs/adr/, docs/decisions/) are binding; read the ones that exist
   if you have not yet. Follow the conventions already in the code around your change. Never
   invent personal data that looks real (names, phone numbers, emails, addresses, photos): use
   placeholders that are clearly fictional, or data that already exists in the repo.
2. Do ALL the requirements in your plan, with tests, wired to where the issue asks for them.
   Deviating from the plan is fine when the code proves the plan wrong; say why in the summary.
   Save context: for searches across many files, use an explore subagent and keep only its
   conclusion; read the parts of files you need, not whole large files, and do not re-read files
   you already read in step 1. Do not page through a file above ~50 KB from the top: find the
   place with `grep -n` first, then read only that line range.
   When done, write .git/agent-checklist.json: a JSON array with one object per requirement,
   {"item": "...", "done": true|false, "evidence": "file:line and test name"}.
   "done": true only when the code exists, is wired in (used, not a stand-alone function or
   component), and a test or check proves it. A reviewer re-checks this checklist; a false claim
   will be found.
3. Do not touch .github/, deploy/, or existing migration files. A new migration is fine, as a new
   file next to the existing ones.
4. Before you finish, run the project's build and its full test suite the way its CI does, until
   everything passes. For a Rust workspace that is:
     cargo build --workspace --locked
     cargo test --workspace --locked
   For an npm project:
     npm ci
     npm run check --if-present
     npm run build
     npm test --if-present
   While you work, run only focused tests (`cargo test -p <crate> <filter>`, `npm test -- <filter>`).
   The full suite once at the end is enough: the final verify runs everything again, so repeating
   it every iteration only wastes time. An e2e suite (Playwright) is run by root in the final
   verify, on a private network; you do not need to run it.
5. Commit every change to the active branch. The branch is already set up. Do not push,
   do not change the remote, do not create other branches. The working tree must be clean at the end.
6. Write the PR summary in English to .git/agent-pr-body.md: what changed, why, how it was tested,
   and what was deliberately left out. Do not write "Closes #..." — that is added automatically.
7. If it turns out this issue cannot be done properly — it needs a human decision or data that is
   not in the repo — do not force it. Commit nothing, and write the reason to .git/agent-blocked.md.
