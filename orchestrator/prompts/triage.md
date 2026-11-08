Step 1 of 2: PLAN. Do not change, create, or delete any file in this step.

First read the repo's own rules, if they exist: AGENTS.md, CLAUDE.md, CONTRIBUTING.md, CONTEXT.md,
docs/DESIGN.md, docs/PLAN.md, and any decision records under docs/adr/ or docs/decisions/. Their
rules are binding.

The sandbox has internet access: official documentation may be read while working (note the URL
and the date you read it), so that is not a blocker. A blocker is only data that needs a login or
credentials, verification by a named human, or a design or architecture decision the repo's docs
do not make yet. Read files above ~50 KB with `grep -n` first, then only the line ranges you need.

Read as much code as you need to know where this issue touches the repo. For searches across many
files, use an explore subagent and keep only its conclusion.

The goal is to finish EVERYTHING this issue asks for, in this PR. Not a slice, and not a component
or function nobody uses yet: every capability must be wired to where the issue asks for it (page,
endpoint, command, API) and have a test or check that proves it. If slices of this issue were
already merged (listed above), continue from there; do not redo what exists.

End your answer with exactly one ```json block shaped like this:

```json
{
  "decision": "go",
  "reason": "one sentence",
  "requirements": [
    "every request or acceptance criterion in the issue, one per item, worded close to the issue"
  ],
  "slice": "how all of those requirements will be done, 3-8 sentences",
  "files": ["path/to/a/file/you/will/touch"],
  "tests": "which tests prove each requirement"
}
```

The "requirements" list must be complete: read the issue top to bottom, comments included, and
leave nothing out. This is the list that gets checked item by item later.

Use "decision": "blocked" when:
- this issue needs the result of another issue that is not done yet. Put those issue numbers in
  "depends_on", for example "depends_on": [18, 22]. This issue is retried automatically once
  all of them are closed, so name only what truly has to exist first.
- a comment says this work is happening in another PR or branch, or the issue needs a human
  decision nobody has taken yet (for example choosing a design or architecture direction the
  docs do not settle), or data that is not in the repo. Leave "depends_on" empty.
Put exactly what is being waited for in "reason".
