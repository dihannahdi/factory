Step 2 of 2, ADOPT VARIANT. The work below does not start from scratch: a human already worked on
this issue, and their commits ARE ALREADY on the active branch (the latest main is merged into it;
the diff is in step 1). You finish their work; you do not replace it.

Your order of work, replacing the opening of the general rules below:

A. AUDIT first, before changing anything. For EVERY requirement in your plan: check in the existing
   code whether it is met, wired to where the issue asks for it (used, not a stand-alone function
   or component), and proven by a test or check. Write the result to
   .git/agent-checklist.json NOW: one object per requirement,
   {"item": "...", "done": true|false, "evidence": "file:line and test name"}.
   Be honest: "done": true only for what you saw met in the code yourself; the evidence for what
   the human did is a file:line in their code.
B. BUILD only what is not met (done: false), with tests, and update the checklist as each item is
   finished.
C. Keep the author's design, structure, names, and style. Change their work only when it
   (1) breaks what the issue asks for, (2) breaks the repo's rules (AGENTS.md, CLAUDE.md,
   CONTRIBUTING.md, docs/DESIGN.md, decision records), or (3) a test proves it wrong. Give the
   reason for every such change in the summary. Do not rewrite their work wholesale, do not move
   or rename files without need, do not tidy style the issue did not ask about.
D. The output contract is the same as in the general rules below: commit every change (clean
   working tree), an honest checklist in .git/agent-checklist.json, a PR summary in
   .git/agent-pr-body.md (say what was already there from the human, what you added, and what you
   changed in their work and why). Do not push and do not change the remote.
   If every requirement is already met and nothing needs changing, do not make an empty commit:
   writing the checklist and the summary is enough.

General rules of the BUILD step (they apply here too, except where replaced above):
