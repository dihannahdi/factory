# factory contracts

The orchestrator (root, bash), the console backend (Node, unprivileged) and the console
frontend (Svelte) meet only through the files and the HTTP API below. Nothing else is shared.
If an implementation needs something that is not here, change this file first.

Fixtures for every shape live in `contracts/fixtures/`. `console/dev/simulate.mjs` animates them.

## 0. Conventions

- All timestamps written by root are **epoch seconds** (integers). Fields written by the console
  named `at` are **ISO 8601 UTC** strings. Event timestamps inside opencode logs are epoch ms.
- Slot numbers `K` are 1, 2 or 3. `AGENTS_MAX = 3`.
- Every JSON file is written by **one** writer, atomically (write `.<name>.<rand>` in the same
  directory, then `rename`). Readers keep the last good value when a read fails to parse.
- Models are full opencode ids: `^opencode(-go(@[0-9]+)?)?/[a-z0-9][a-z0-9._-]{0,63}$`. `opencode/` ids are the free tier; `opencode-go/` ids are the paid OpenCode Go subscription, the only ids allowed to cost money (3.3). `opencode-go@N/<model>` is the same model on Go account N (account 1 has no suffix); opencode itself is given `opencode-go/<model>` with account N's key. `contracts/fixtures/model-ids.json` is the test set for this grammar, and every validator in this repo is tested against it.
- Issue numbers are positive integers. Strings shown to humans are untrusted (issue titles, agent
  text, steer messages): never render them as HTML.

## 1. Directories and permissions

| Path | Owner:group | Mode | Writer |
|---|---|---|---|
| `/var/lib/factory/` (sessions, blocked, claims, cooldown, adopt, locks, control.last-good.json) | root:root | 700 | root |
| `/var/lib/factory-ops/` | root:factory-ops | 750 | — |
| `/var/lib/factory-ops/ui/` and `ui/slots/` | root:factory-ops | 2750, files 640 | root only |
| `/var/lib/factory-ops/ctl/` | root:factory-ops | 2770, files 660 | console only |
| `/var/log/factory/issue-<n>-<YYYYMMDDTHHMMSSZ>-s<K>/` | root:factory-ops | 2750, files 640 | root |
| `/etc/factory-console/{auth.json,secret}` | root:factory-console | 750 / 640 | root (`console/bin/passwd.mjs`) |
| `/home/factory/s<K>/{work,out,target}` | factory | — | agent sandbox for slot K |

Root only **reads** `ctl/`: it refuses symlinks, non-regular files and files over 64 KB, validates
every field, never echoes raw content into logs, and falls back to
`/var/lib/factory/control.last-good.json` (then to defaults) when invalid.

## 2. `ctl/` — written by the console

### 2.1 `ctl/control.json`
```json
{"v":1,"agents":1,"models":["opencode/deepseek-v4.1-flash-free"],"model_mode":"ordered",
 "paused":false,"queue":[{"n":24,"at":"2026-10-16T05:00:00Z"}],"skip":[76],
 "resume_ack":null,"updated_at":"2026-10-16T05:00:00Z"}
```
| Field | Rule |
|---|---|
| `agents` | integer 0..3. 0 = no new work; running lanes drain (finish their issue), never killed. |
| `models` | 1..5 model ids (`opencode/...` or `opencode-go/...`), order = fallback order. The console accepts only ids in `ui/models.json` `free` ∪ `paid`. Root drops ids that are not eligible (3.3: `zero_retention == true`, free + paid); if none remain it uses the first eligible one that is not cooling (paid first). |
| `model_mode` | `ordered` (use `models` as given) or `auto` (root ranks `models` by delivered results). In both, a model in cooldown goes last. |
| `paused` | true = no lane picks new issues or shepherds; running turns finish their current step and park. |
| `queue` | ≤ 50 `{n, at}`. Picked first, in order. A queued pick ignores `agent-failed` / `agent-blocked` labels (that is how a human says "try again"). One-shot: active only while `at` is later than `ui/consumed.json[n]`. |
| `skip` | ≤ 200 issue numbers. Never picked, never shepherded. |
| `resume_ack` | id of the halt the human acknowledged (see `ui/halt.json`), or null. |
| defaults | `{"v":1,"agents":1,"models":["opencode/deepseek-v4.1-flash-free"],"model_mode":"ordered","paused":false,"queue":[],"skip":[],"resume_ack":null}` |

### 2.2 `ctl/interrupt-<K>.json`
```json
{"v":1,"id":"8b0c2f4e-1d2a-4c55-9a8e-2b8f0f1c9d10","run_id":"ab12cd34ef56...",
 "action":"steer","skip":false,"message":"Use the shipping presets from docs/DESIGN.md, not constants.",
 "at":"2026-10-16T06:30:00Z"}
```
- `run_id` must equal `ui/slots/K.json.run_id`; otherwise root ignores it (stale).
- Root acts once per `id` and reports in `ui/slots/K.json.interrupt` / `.steer`. Root never
  deletes or edits this file; the console overwrites it for the next interrupt.
- `action:"stop"`: stop the lane's current issue now. Outcome `stopped` (never `agent-failed`).
  `skip:true` also means the console has added the issue to `control.skip`.
- `action:"steer"`: `message` 1..2000 chars, control characters stripped except `\n`. Delivered
  to the agent as "Arahan manusia: …" — immediately if a model turn is running (the turn is cut and
  resumed in the same session), otherwise at the lane's next steer point.
- Inside merge + deploy nothing is interrupted: `state` shows `sub:"stop deferred"` and the
  stop applies right after.

## 3. `ui/` — written by root

### 3.1 `ui/slots/<K>.json`
Written on every change and every 30 s as a heartbeat while waiting. The console marks a lane
`stale` when `run_id != null` and `updated` is older than 120 s.
```json
{"v":1,"slot":1,"run_id":"ab12cd34ef56...",
 "state":"running","stage":"build","sub":"complete 2/4",
 "issue":{"n":24,"title":"[CART-01] Add a saved-cart page ...","tag":"CART-01","family":"CART","url":"https://github.com/acme/shop/issues/24"},
 "pr":null,
 "model":"opencode/deepseek-v4.1-flash-free","session":"ses_ebcb87204ffeiYQE3LcxYNhHmu",
 "turn":{"phase":"complete2","started":1792130000,"events":"/var/log/factory/issue-24-20261016T055517Z-s1/complete2-0.jsonl"},
 "stage_started":1792129900,"issue_started":1792129717,
 "tokens":{"input":161234,"output":21877,"reasoning":10945,"cache_read":4011223},
 "requirements":{"total":9,"done":6},
 "ci":null,
 "steer":{"pending":null,"last":{"id":"...","message":"...","applied_at":1792130100,"outcome":"applied"}},
 "interrupt":{"last_id":"...","action":"steer","handled_at":1792130100},
 "note":"",
 "effective_agents":1,
 "log_dir":"/var/log/factory/issue-24-20261016T055517Z-s1",
 "updated":1792130123}
```
| Field | Values |
|---|---|
| `state` | `parked` (K > effective agents) · `idle` (between issues) · `running` · `draining` (agents lowered, finishing this issue) · `stopping` · `stopped` (interrupted; shows 60 s then idle) · `halted` · `backoff` (all models cooling; `note` says until when) |
| `stage` | `pick` `plan` `build` `verify` `review` `pr` `ci` `merge` `deploy` `live`, or null when idle/parked |
| `sub` | ≤ 40 chars: `complete r/4`, `fix r/R`, `conflict`, `steer`, `update-branch`, `waiting merge lock`, `waiting runner`, `stop deferred`, or "" |
| `turn` | non-null exactly while a model turn runs; `events` is the opencode JSON-lines file being written right now |
| `requirements` | from `.git/agent-checklist.json` once it exists, else null |
| `ci` | during `ci`/`merge`: `{"checks":[{"name":"Build and test","status":"completed","conclusion":"success"}],"head":"<sha>"}`, else null |
| `pr` | `{"n":140,"url":"...","head":"<sha>"}` once opened |

Stage mapping: plan turn (and `replan`, the one extra plan turn after a dependency cycle) → `plan`; build and completion turns → `build`; verify runs and their fix
turns → `verify`; review turn and its fixes → `review`; export + PR creation + conflict turns →
`pr`; CI wait and CI fix turns → `ci`; merge lock, update-branch, merge → `merge`; deploy wait →
`deploy`; healthy → `live` for 60 s, then `idle`.

### 3.2 `ui/github.json` (sync, every 60 s)
```json
{"v":1,"updated":1792130000,"ok":true,"error":null,
 "issues":[{"n":24,"title":"...","tag":"ELE-01","family":"ELE","milestone":"M2","priority":"P0",
   "labels":["area/electrical","kind/parity","P0"],
   "class":"running","reason":"lane 1","deps":[],"deps_all":[22,9],"taken_by":[],"claimed_by":1,"order":null,
   "url":"https://github.com/acme/shop/issues/24",
   "size":{"chars":1840,"bullets":9,"checkboxes":3}}],
 "done":[{"n":22,"title":"[LAY-01] ...","tag":"LAY-01","milestone":"M2","closed_at":1792310000,
   "reason":"completed","deps":[9]}],
 "prs":[{"n":131,"issue":15,"title":"...","head":"<sha>","agent":false,"adopt":true,"ci":"pass","mergeable":"MERGEABLE",
   "created":1791460000,"url":"..."}],
 "adopt_ignored":[{"pr":141,"reason":"the PR comes from a fork or its origin is not verified"}],
 "runner":{"queued":0,"in_progress":1},
 "main":{"sha":"52f460a7d0807b0ce1436d8a7e402c227f38f9a3",
   "deploy":{"sha":"52f460a7...","status":"completed","conclusion":"success","url":"..."}},
 "health":{"ok":true,"checked":1792130000}}
```
`class` is exactly what pick would do, from one shared classifier:
`running` (claimed by a lane) · `queued` (in control.queue, active) · `eligible` (would be picked
automatically; `order` gives the pick order) · `taken` (an open PR names it; `taken_by` lists PR
numbers) · `blocked` (waits for `deps`) · `failed` (label agent-failed) · `skipped`
(control.skip or label agent-skip) · `ineligible` (no milestone, assigned, …; `reason` says why).
`order` is null for every class except `queued` and `eligible`.

`deps_all` = every issue the body declares on its "Depends on" line ("Blocked by" and the Indonesian "Bergantung pada" work too) (`declared_deps` in
`lib.sh`, the parser the classifier uses), whatever its state, plus `deps`: what this issue ever depended on, for the
console's dependency map. Only `deps` blocks a pick.

`done` = every closed issue, for the same map: `{n, title, tag, milestone, closed_at (epoch s or
null), reason ("completed" | "not_planned" | ...), deps (declared, whatever their state)}`, sorted by
`n`; bodies are never written. Sync fetches it at most every `DONE_TTL` seconds (default 600, the
bodies of every closed issue are its heaviest call) and keeps the last good list when a fetch fails.
Readers must treat both keys as optional.

`size` = `{chars, bullets, checkboxes}` of the issue body, numbers only (the body itself is never
written to `ui/`): `chars` is the body length, `bullets` counts lines matching `^\s*([-*]|\d+[.)])\s+\S`,
`checkboxes` lines matching `^\s*[-*]\s*\[[ xX]\]`. A missing body is `{0,0,0}`. The console feeds it to
the size model of 5.3; readers must treat the key as optional.

**Adopting a human PR (label `agent-adopt`).** A human can hand an open pull request to the machine
by putting the GitHub label `agent-adopt` on it. The label counts only when **all** hold: the PR is
open; its head repo is the base repo (`isCrossRepository == false`, never a fork); its body has
exactly **one** distinct closing reference (`Closes|Fixes|Resolves #N`, any case; the same number
twice is still one); issue N is open; the PR does not already carry `agent`; and no lower-numbered
adopted PR already claims N. Anything else with the label is ignored and listed in
`adopt_ignored` as `{pr, reason}` (reason is a human sentence, untrusted text), never an error.

For an adoptable PR `P` closing issue `N` the classifier changes only issue N:
- the issue gets the extra field **`adopt_pr: P`** (present only then; every other issue lacks the
  key, so readers must treat it as optional), in every class, so the console can show "PR #P adopted"
  next to `running`, `blocked`, `failed` ...;
- `P` does not make N `taken` (other PRs that name N still do);
- if nothing else stops it, `class` is `eligible` with `reason` `"PR #P adopted"`. The milestone and
  assignee checks do not apply to an adopted issue (the label is the explicit request); the rest of
  the chain is unchanged: a live claim means `running`, `control.skip` / `agent-skip` means `skipped`,
  `agent-failed` means `failed`, open dependencies (`agent-blocked` or declared) mean `blocked`,
  `control.queue` still means `queued`;
- adopted issues are ordered **before every fresh eligible issue** (after `queued`), then by the
  usual milestone, priority, family-not-busy and number; no milestone sorts last among them;
- retry cap: after `ADOPT_MAX_RUNS` (default 2) adoption runs on the same PR head the issue is
  `ineligible` (reason `"PR #P adopted: already 2 attempts on the same head, waiting for a new push"`)
  until the head changes. The head the lane itself pushed does not reset the count; a human push does.

`prs[].adopt` is true when the PR carries `agent-adopt`. The console keeps working unchanged: it
ignores keys it does not know, and `adopt_pr`, `adopt_ignored` and `prs[].adopt` are all optional for it.

Lane behaviour on an adopted issue (slot status as for any issue N, `pr` = P from the start, `note`
= `"adopsi PR #P (<branch>)"`):
1. checkout of the PR head (`refs/pull/P/head`); if main is not an ancestor, `git merge main` (never
   a rebase; a conflict is an agent turn, then verify);
2. plan turn: issue text plus the PR's `git diff --stat` and diff against main (capped at
   `ADOPT_DIFF_MAX`, default 60000 characters) and the statement that a human already started;
3. build turn (`prompts/adopt.md` then `prompts/prompt.md`): audit the existing work against every
   requirement, write `.git/agent-checklist.json` honestly, implement only what is missing, keep the
   human's design; then `complete_loop`, verify, review in a fresh session, as for issues;
4. export: fast-forward only, to the PR's own head branch, no `--force`. If the remote head is not
   the one that was checked out the run ends with outcome `adopt_moved` and nothing is overwritten;
5. one PR comment with the agent summary (checklist with evidence, review, steer quotes, cost line);
   the PR body is never replaced and no PR is opened;
6. checklist full: labels `agent` and `agent-reviewed` are added (only now), the lane carries on as
   shepherd (CI, merge, deploy; outcome `adopted`). Checklist not full: no `agent` label, no merge,
   the comment lists what is missing, the PR stays open with `agent-adopt`, outcome
   `adopt_incomplete`, and the issue is **not** labelled `agent-failed`.
Failures (`verify_failed`, `conflict`, `guard`, `blocked`, `waiting`) behave as for issues, except that
the PR is never closed, its branch never deleted, and it gets a comment saying it was left untouched.
Shepherd merges an adopted PR only while its adoption record says the checklist was complete, and
`open_agent_prs` lists an adopted PR only then (root-only record `/var/lib/factory/adopt/<pr>.json`:
`{issue, human_head, last_head, runs, complete}`). When the lane gives up on an adopted PR after
`agent` was added, it removes `agent`, `agent-reviewed` and `agent-adopt` instead of closing it.

### 3.3 `ui/models.json` (sync: free list every 30 min; cooldown, paid, spend every run)
```json
{"v":1,"updated":1792130000,
 "free":[{"id":"opencode/deepseek-v4.1-flash-free","name":"DeepSeek V4.1 Flash Free","context":200000,"output":32000,"trains_on_data":false,"zero_retention":true}],
 "paid":[{"id":"opencode-go/deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","context":200000,"output":32000,"trains_on_data":false,"zero_retention":true}],
 "cooldown":{"opencode/deepseek-v4.1-flash-free":{"until":1792131000,"reason":"rate_limit"}},
 "spend":{"h5":1.23,"week":4.5,"month":6,"budget":{"h5":14,"week":36,"month":76}},
 "source_ok":{"zen":true,"modelsdev":true}}
```
`free` = ids listed by `https://opencode.ai/zen/v1/models` with `cost.input == 0` and
`cost.output == 0` under provider `opencode` in `https://models.dev/api.json`.

Data policy per entry (from opencode.ai/docs/zen). `trains_on_data` and `zero_retention` are each
`true | false | null` (null = not documented, treat as unsafe for a private repo):
- trains (`trains_on_data:true, zero_retention:false`): `muse-spark-*-contributor-*`, `big-pickle`,
  `nemotron-*`, `ll-alpha-*`, `exo-*`, `mimo-*`.
- kept but not trained on (`false/false`): `cat-jam-*` (30-day retention).
- zero retention (`false/true`): `deepseek-*`, `space-bunny-*`, `longcat-*`.
- anything else: `null/null`.

`paid` exists only while `/etc/opencode/go.key` is installed and safe (regular file, not a symlink,
owner root, group factory, mode 0640, 20..512 bytes); it lists env `GO_MODELS` (default
`opencode-go/deepseek-v4.1-flash`) that also exist under `opencode-go` in models.dev. Entries have
the same keys as `free`; `zero_retention:true` only for models with documented ZDR (`GO_ZERO_RETENTION_RE`),
otherwise null. `spend` (USD) comes from the shell function `spend_summary` (`$STATE/spend.jsonl`) and
is omitted when that function is not defined; `budget` comes from env `GO_BUDGET_5H/WEEK/MONTH`
(defaults 14/36/76).

The managed opencode whitelist is rewritten by sync to exactly the `free` set. With a safe Go key it
also sets `enabled_providers: ["opencode","opencode-go"]` and
`provider."opencode-go"` = `{options:{apiKey:"{file:/etc/opencode/go.key}"}, whitelist:[...]}`; without
one, `enabled_providers: ["opencode"]` and no `opencode-go` block.

**Eligibility (root, `models_refresh`).** A lane uses only ids of `free` + `paid` whose
`zero_retention == true`; `null` and `false` are excluded (they train on or log our prompts). Order
= `control.models` filtered to the eligible ones; if none of them is eligible, the first eligible
one that is not cooling, paid first. Old shape (no entry anywhere has a `zero_retention` key): every
`free` id is eligible, as before. A `paid` id that does not start with `opencode-go/` is ignored.

**Money.** `cost > 0` on any model outside `opencode-go/` still halts every lane. Each turn of an
`opencode-go/` model appends `{"ts","slot","issue","model","cost"}` to root's
`/var/lib/factory/spend.jsonl`; `spend_summary` (lib.sh) prints `{"h5","week","month"}`, the
sums in USD over the trailing 5 h, the week since Monday 00:00 UTC (when OpenCode resets its
weekly cap) and the trailing 30 d. Budgets `GO_BUDGET_5H=14`, `GO_BUDGET_WEEK=36`,
`GO_BUDGET_MONTH=76` (env, defaults in lib.sh) leave room under OpenCode's $16 / $40 / $80 for
the turns still in flight when a budget is reached (the subscription serves only this agent):
a Go model at or over any budget is put in cooldown with reason `budget`
until the window frees (the week: next Monday 00:00 UTC), so the lanes fall back to the free models
in `control.models`, or back off when it lists none; nothing halts.
Cooldown `reason` is `rate_limit`, `other`, `stalled` or `budget`.

### 3.4 `ui/halt.json` — present only while halted
```json
{"id":"1792130000-deploy","reason":"deploy 1a2b3c4 failed (failure)","at":1792130000,
 "issue_url":"https://github.com/acme/shop/issues/150"}
```
Halted ⇔ the file exists and `control.resume_ack != id`. While halted no lane picks, merges or
starts a turn. Reasons: failed deploy, unhealthy site, free model gone, `cost > 0` on a model outside `opencode-go/`, a Zen key
found on the box.

### 3.5 `ui/consumed.json`
`{"24":"2026-10-16T05:01:10Z"}` — when root started a queued issue.

### 3.6 `ui/stats.jsonl` — append-only, one JSON object per line (flocked by root)
Readers must skip a partial last line. Every line has `ts`, `issue`, `slot`, `kind`.
```json
{"ts":1792129717,"issue":24,"slot":1,"kind":"call","phase":"plan","model":"opencode/deepseek-v4.1-flash-free","rc":0,"model_error":false,"rate_limited":false,"stalled":false,"cost":0,"secs":162,"tokens":{"input":58748,"output":2562,"reasoning":5469,"cache_read":585984}}
{"ts":1792131400,"issue":24,"slot":1,"kind":"stage","stage":"verify","secs":412,"result":"ok"}
{"ts":1792131500,"issue":24,"slot":1,"kind":"steer","phase":"build","outcome":"applied"}
{"ts":1792133000,"issue":24,"slot":1,"kind":"outcome","outcome":"merged","model":"opencode/deepseek-v4.1-flash-free","url":"https://github.com/acme/shop/pull/140","sha":"..."}
```
`rate_limited` is true when the turn ended in a rate limit, whether opencode reported it as an error event or the watchdog saw it only in opencode's own log; `stalled` is true when the watchdog ended a turn with no events and no CPU for `IDLE_TIMEOUT` (900 s). Both mean "model error": the model cools and the same session resumes on the next model; neither is an issue failure. `cost` is the turn's real cost (only `opencode-go/` may be > 0).
`{"ts":…,"issue":24,"slot":1,"kind":"ci_rerun","head":"<sha>","pr":"140"}`: CI failed on that PR head
and root re-ran the failed jobs once before spending a fix round (a flaky spec is then not the
issue's failure). At most one per head. Readers that do not know a `kind` skip the line.

`stage.result`: `ok` `fail` `stopped` `timeout`. `outcome.outcome`: `pr` `merged` `waiting`
(blocked on deps) `blocked` (needs a human) `no_commit` `verify_failed` `ci_failed` `ci_wait`
`conflict` `guard` `retry` `stopped` `ready` (MERGE_MODE=pr: CI green and reviewed, labelled `agent-ready`
for a human to merge; the PR is the one named in `url`), and for adopted PRs (3.2) `adopted` (checklist full, handed to the
shepherd; the PR is the one named in `url`), `adopt_incomplete` (pushed what was done, PR stays open, not merged,
issue not failed) and `adopt_moved` (the PR head moved on GitHub during the run, nothing pushed). The console
shows unknown outcome names with a neutral mark. Lines written before this contract have no `slot`; treat
them as slot 1.

## 4. opencode event logs (what the press strikes on)

`turn.events` points at a JSON-lines file written by `opencode run --format json`. Real sample:
`fixtures/log/plan-0.jsonl`. Every event: `{"type", "timestamp" (ms), "sessionID", "part":{...}}`.

| `type` | Use |
|---|---|
| `step_start` | a model step began |
| `text` | `.part.text` — assistant prose |
| `tool_use` | `.part.tool` (`bash` `read` `edit` `write` `grep` `glob` `list` `todowrite` `task` `webfetch` …), `.part.state.status` (`completed` `error` …), `.part.state.input`, `.part.state.title` |
| `step_finish` | `.part.tokens {input, output, reasoning, cache{read,write}}`, `.part.cost` (must be 0) |
| `error` | `.error.name`, `.error.data.message` |

## 5. Console HTTP API — `127.0.0.1:4420`, JSON

Every `/api/*` route except `GET /api/health` and `POST /api/login` requires the session cookie
(else 401 `{"error":"auth"}`). Every non-GET request must carry `Content-Type: application/json` (else 415) and `Origin: https://factory.example.com`
(configurable `HC_ORIGIN`) or gets 403 `{"error":"origin"}`.

| Method, path | Body | Responses |
|---|---|---|
| GET `/api/health` | — | 200 `{"ok":true}` |
| POST `/api/login` | `{"email":"...","password":"..."}` | 204 + `Set-Cookie: __Host-hc=<exp>.<nonce>.<hmac>; Max-Age=604800; Path=/; Secure; HttpOnly; SameSite=Strict` (the `__Host-` prefix forbids a Domain attribute, so no other subdomain can set or overwrite it) · 401 `{"error":"bad_credentials"}` · 429 `{"error":"rate_limited","retry_after":<s>}` (global: 5 failures / 15 min → 15 min lock) |
| POST `/api/logout` | — | 204, cookie cleared |
| GET `/api/state` | — | 200 Snapshot |
| GET `/api/stream` | — | SSE (below) |
| POST `/api/control` | partial `{agents?, models?, model_mode?, paused?, resume_ack?}` | 200 `{"control":Control}` · 400 `{"error":"invalid","field":"agents"}` |
| POST `/api/issues/:n` | `{"action":"queue"\|"unqueue"\|"skip"\|"unskip"}` | 200 `{"control":Control}` · 400 · 404 (issue not open) |
| POST `/api/slots/:k/interrupt` | `{"action":"stop"\|"steer","message?":"...","skip?":false}` | 202 `{"id":"<uuid>"}` · 409 `{"error":"no_run"}` (slot has no `run_id`) · 400 |

`HC_READONLY=1` makes every POST except login/logout return 403 `{"error":"readonly"}` (rollout
step I1); the snapshot reports it as `readonly:true` so the UI greys the controls.

### 5.1 Snapshot (`GET /api/state`, and the first SSE event)
```json
{"v":1,"now":1792130123,"readonly":false,
 "control":{...},"slots":[Slot1,Slot2,Slot3],
 "activity":{"1":[Item, ...≤50],"2":[],"3":[]},
 "github":{...},"models":{...},"halt":null,"consumed":{...},
 "metrics":Metrics,
 "recent":[{"ts":1792133000,"issue":24,"slot":1,"outcome":"merged","model":"opencode/...","url":"..."}]}
```
`slots` always has 3 entries (missing files → `{"slot":K,"state":"parked",...nulls, "updated":0}`; `updated` 0 means the lane never wrote its file). `recent` =
last 30 `outcome` lines, newest first.

### 5.2 Activity item — parsed by the console from `turn.events`
```json
{"t":1792129929580,"kind":"tool","tool":"bash","target":"cargo test -p shop-core string_window",
 "text":null,"status":"completed","tokens":null}
```
| `kind` | from | fields |
|---|---|---|
| `tool` | `tool_use` | `tool`; `target` ≤ 120 chars: bash → first line of `input.command`; read/edit/write → `input.filePath` with `/home/factory/s<K>/work/` (and legacy `/home/factory/work/`) stripped; grep/glob → `input.pattern`; task → `input.description`; webfetch → `input.url`; else `state.title`. `status` |
| `text` | `text` | `text` ≤ 200 chars |
| `step` | `step_finish` | `tokens {in: input, out: output}` |
| `error` | `error` | `text` = `.error.data.message` ≤ 200 |
On first sight of a new `turn.events` path the console reads at most the last 256 KB and sends
`reset:true`.

### 5.3 Metrics (computed by the console from `ui/stats.jsonl` + `ui/github.json`)
```json
{"merged_total":17,"merged_24h":3,"merged_7d":17,"remaining":58,"throughput_per_h":0.5,"eta_h":95,
 "eta":{"p50_h":95,"p80_h":119.8,"lanes":3,"rate_per_lane_h":0.201,"merges_per_issue":1.063,
        "doable":54,"waiting_human":[{"n":53,"tag":"ENG-41"}],
        "size_model":{"active":false,"feature":null,"n":13,"flat_mae":1.3,"mae":null},
        "q_effort":1.159,"q_rate":1.262,"dispersion":1},
 "waste_per_productive_h_7d":0.39,
 "success":{"opencode/deepseek-v4.1-flash-free":{"attempts":4,"merged":1,"rate":0.25}},
 "stage_median_min":{"plan":3,"build":26,"verify":7,"review":11,"ci":9,"merge":1,"deploy":8},
 "bottleneck":"build",
 "tokens_today":{"input":180000,"output":24000,"cache_read":4500000},
 "tokens_total":{"input":62340511,"output":4274993,"reasoning":6472967,"cache_read":2953312439,"since":1791459632},
 "rate_limited_1h":0}
```
`merged_total` = every `merged` outcome kept from `ui/stats.jsonl` (the reader keeps the newest
100,000 records). `remaining` = issues of class `queued` `eligible` `running` `blocked`. `throughput_per_h` = merges
in the last 48 h ÷ 48 (display only; it no longer drives the ETA).
`tokens_total` = Σ `tokens` of every `call` record in `ui/stats.jsonl` (`since` = the oldest call `ts`, null
when there is none). It is summed as lines are read, so the 100,000-record window does not shorten it; it
restarts only when the file is replaced. The pulse strip shows `input + output`; reasoning and cache reads
are in the tooltip. `bottleneck` = stage with the largest median. "Today" is a day in the console's `HC_TZ` zone (default: the server's own). `success.attempts`
counts outcomes `pr` `merged` `no_commit` `verify_failed` `ci_failed` attributed to that model.

**ETA v2** (`eta`, and `eta_h` = `eta.p50_h` for compatibility). `eta` and `eta_h` are **null unless
≥ 3 `merged` outcomes in the last 7 days and busy lane-hours > 0**. The old formula
(remaining ÷ merges-per-hour over 48 h) counted issues that wait on humans, divided by wall-clock hours
in which lanes sat idle or parked, and ignored issues that take more than one PR.
- *doable* = issues of class `queued` `eligible` `running` `blocked` whose dependency closure (`deps`,
  restricted to issues present in `github.json`) holds no issue of class `failed` `taken` `ineligible`
  `skipped` and no issue on a dependency cycle (an issue that reaches itself through `deps`; only a human
  can break it). The rest of those four classes is `waiting_human`, as `[{n, tag}]`.
- *merges_per_issue* = `merged` outcomes ÷ distinct issues with a `merged` outcome, all time, at least 1.
- *c* (`rate_per_lane_h`) = `merged` outcomes in the last 7 days ÷ busy lane-hours in the last 7 days,
  where busy = Σ `secs` of `stage` records with `stage != "pick"` and `ts` in the window.
- *L* (`lanes`) = min(`control.agents`, every slot's `effective_agents` that is > 0, 3), at least 1.
- flat cost per doable issue = merges_per_issue ÷ c lane-hours. **P50** = makespan of a list-scheduling
  simulation: L lanes, an issue becomes ready when all its doable dependencies are done, longest
  remaining chain first, durations = cost. **P80** = the same simulation with every cost ×
  max(`q_effort`, `q_rate`). `p80_h` is never null when `eta` is set; clients still accept null from an
  older console, and `q_effort` `q_rate` `dispersion` default to null when absent.
- `q_effort` = p80 ÷ p50 (linear-interpolated quantiles) of the effort of each completed issue, effort = Σ
  `stage` secs (excluding `pick`, all time) of an issue that has a `merged` outcome and no `adopted`
  outcome; null when fewer than 5 issues qualify.
- `q_rate` = exp(z₈₀ · √(φ · (1/m₇ + 1/N))), z₈₀ = 0.8416 (standard normal 80th percentile), m₇ = `merged`
  outcomes in the last 7 days, N = doable × merges_per_issue (the term is dropped when N = 0). It is the
  uncertainty of the rate itself: it was measured from m₇ merges and the remaining work is N more, and
  both relative variances are φ ÷ count, added in log space. `dispersion` = φ, the day-to-day
  overdispersion (quasi-Poisson): the last 7 days are cut into 24 h buckets ending now; a bucket with no
  busy time hands its merges to the next bucket that has some (the last such bucket takes what is left);
  φ = Pearson χ² ÷ (buckets − 1) with expected merges c × busy_d, at least 1. With fewer than 3 buckets
  φ = 1 is used and `dispersion` is null (not measured yet). A steady week gives φ = 1; a day of incidents that burns lane-hours without merging raises
  it, and P80 widens while P50 stays.
- *size model* (`eta.size_model` = `{active, feature, n, flat_mae, mae}`) is **off by default**: size read
  from the issue text did not predict effort (13 issues: best leave-one-out MAE 1.26 lane-h against 1.30
  flat). Every 10 minutes the console takes the completed issues above with effort > 0.2 lane-h and
  the features of the newest run dir's `issue.json` (`chars`, `bullets`, `checkboxes`, `epic` = title
  matches /epic/i). Only with n ≥ 30 does it compare, per feature, the leave-one-out MAE of
  ln(effort) = a + b·ln(1+feature) with the flat geometric mean (`flat_mae`), and it activates the best
  feature only if its MAE ≤ 0.85 × `flat_mae`. Then cost_i = flat cost × pred_i ÷ mean(pred over the
  calibration set); a doable issue with no `size` in 3.2 keeps the flat cost. `n` and `flat_mae` are
  always reported (`flat_mae` is null while n < 2); `feature` and `mae` are null while inactive.

**Waste** (`waste_per_productive_h_7d`). Stage records are grouped per slot into runs: records accumulate
until that slot's next `outcome` record; a run's secs = Σ its `stage` secs excluding `pick`, and its end
is the outcome `ts`. Stage records after a slot's last outcome are a run in progress and are left out.
A run ending in `pr` `merged` `adopted` is productive; every other outcome (`no_commit` `blocked`
`ci_failed` `waiting` `verify_failed` `stopped` `conflict` `guard` `oom` `retry` ...) is waste. The value is
waste secs ÷ productive secs over runs that ended in the last 7 days, null when productive is 0.
It is an approximation: a run that ends in `pr` counts as productive even if that PR is closed later,
and stage records of a run that never wrote an outcome (a crash) are charged to the slot's next run.

### 5.4 SSE `GET /api/stream`
Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
`X-Accel-Buffering: no`. On connect: `retry: 3000`, then `event: snapshot` with the Snapshot.
Then whole-key replacement events (the client applies them with the same reducer as the
snapshot; there are no diffs):

| event | data | client does |
|---|---|---|
| `slot` | Slot object | `slots[slot-1] = data` |
| `activity` | `{"slot":1,"items":[Item...],"reset":false}` | append (or replace when `reset`), keep last 50 |
| `control` `github` `models` `metrics` `halt` `recent` `consumed` | whole value | replace that key |
A comment `: ping` every 15 s (Cloudflare closes idle streams at 100 s). When the session cookie
expires the server closes the stream; the client then calls `/api/state`, gets 401, shows login.

## 6. Inspect and replay (added with the "alive" pass)

### 6.1 `GET /api/slots/:k/inspect` — the drawer behind a click on a lane's station
200, or 404 `{"error":"no_run"}` when the slot has no `log_dir`. Everything is read from the
slot's `log_dir` (which must resolve inside `HC_LOG_DIR`, same rule as activity).
```json
{"slot":1,"run_id":"...","stage":"build","issue":{"n":27,"title":"...","tag":"OUT-02","url":"..."},
 "pr":null,"ci":null,
 "turn":{"phase":"build","started":1792137000,"items":[Item, ...]},
 "turns":[{"phase":"plan","file":"plan-0.jsonl","first":1792136000123,"last":1792136300456,"items":64}],
 "files":[{"path":"crates/shop-core/src/consumption.rs","edits":7,"reads":3,"last":1792137200123}],
 "checklist":[{"item":"...","done":true,"evidence":"crates/...:120 test_x"}],
 "plan":{"decision":"go","slice":"...","requirements":["..."],"files":["..."],"tests":"..."}}
```
- `turn` = the slot's current `turn.events` file parsed with the §5.2 rules, all items, newest
  2000 at most, oldest first. null when no turn runs.
- `turns` = every `*.jsonl` turn file in `log_dir`, in time order.
- `files` = paths touched across all turn files of this run: `edit`/`write` count as edits,
  `read` as reads; path stripped of `/home/factory/s<K>/work/` (and legacy `/home/factory/work/`).
- `checklist` = `<log_dir>/checklist.json` (root copies `.git/agent-checklist.json` there every
  time it refreshes `requirements`), or null. `plan` = `<log_dir>/plan.json`, or null.

### 6.2 `GET /api/replay` and `GET /api/replay/:id` — replaying a finished (or running) issue
`id` = a log dir basename matching `^issue-[0-9]+-[0-9]{8}T[0-9]{6}Z(-s[1-3])?$`; anything else → 400.
```json
GET /api/replay
{"runs":[{"id":"issue-24-20261016T055517Z","issue":24,"tag":"ELE-01","title":"...","slot":1,
          "started":1792129717,"ended":1792133787,"outcome":"merged","turns":["plan","build","review"],"items":412}]}
```
Newest first, at most 50. `outcome` = the first stats `outcome` line for that issue with `ts`
inside [started, ended + 600], or null. `title`/`tag` from `<log_dir>/issue.json`.
```json
GET /api/replay/:id
{"id":"...","issue":24,"tag":"ELE-01","title":"...","slot":1,"outcome":"merged","url":"https://github.com/.../pull/136",
 "started":1792129717,"ended":1792133787,
 "items":[{"t":1792129720123,"phase":"plan","kind":"tool","tool":"read","target":"crates/...","text":null,"status":"completed","tokens":null}],
 "timeline":[{"t":1792129717000,"stage":"plan"},{"t":1792129880000,"stage":"build"}]}
```
`items` = every turn file's items in time order with their `phase`, at most 5000. `timeline` =
stage changes in epoch ms: from the turn files (phase → stage per §3.1) merged with stats `stage`
lines inside the run's window; ends with the outcome (`pr`/`ci`/`merge`/`deploy`/`live` when the
stats say so). The UI replays `items` against `timeline` at a chosen speed.
