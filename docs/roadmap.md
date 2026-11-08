# Roadmap: from `git clone` to a first PR

Status, 0.1: Phase 0 is mostly done. Done: the de-personalisation, English throughout, generic
prompts, `factory demo` (from a git clone; not yet on npm), `factory doctor`, `factory status`,
`MERGE_MODE=pr` as the default, optional deploy and health checks, a configurable time zone,
SECURITY.md, a license, and CI. Still open from Phase 0: an npm package, so `npx factory demo`
works without cloning, and an opt-in pick label. Everything below that is not on that list is
still a plan.

Section 1 describes the install path as it was before 0.1, and is kept as the reason for the plan.

## 1. A stranger's path today

There is no documented path. Reading the install scripts backwards gives about 16 manual steps, and most of them assume one particular VPS:

| # | Step | Where it is assumed |
|---|---|---|
| 1 | A Linux box with systemd, as root | `deploy/orchestrator-install.sh`. `sandbox.sh` uses `systemd-run`, and slices and transient units are used everywhere |
| 2 | Install jq, flock, curl, git, and Node 22 at exactly `/usr/local/bin/node` | `orchestrator-install.sh`, `console-install.sh` |
| 3 | Create the sandbox user, plus a reviewer user. No script does this | `orchestrator-install.sh`, `sandbox.sh` (the user allowlist is hardcoded) |
| 4 | Put `gh` at `/opt/<name>-agent/bin/gh` | `orchestrator-install.sh`, `lib.sh` |
| 5 | Install opencode into the agent's home and add a wrapper at `/usr/local/bin/<name>-opencode`. Neither is in the repo | `lib.sh`, `run.sh` |
| 6 | Write the token to `/etc/<name>-agent/gh-token` | `orchestrator-install.sh`, `lib.sh` |
| 7 | Optional: Postgres 16 binaries unpacked at a fixed path | `run.sh` |
| 8 | Override the defaults that point at the author's repo and site | `lib.sh` (`REPO`), `lib.sh` (`HEALTH_URL`), `run.sh` (a data-API credential path) |
| 9 | Fit the repo to `VERIFY_KIND`, which is either the author's Rust+Astro layout or `node` | `run.sh` hardcodes `cargo`, `frontend/`, and a repo-specific check script |
| 10 | Rewrite the four prompts. They are in Indonesian and cite the author's ADRs and crate names | `prompts/prompt.md` |
| 11 | Create six labels by hand (`agent`, `agent-reviewed`, `agent-failed`, `agent-blocked`, `agent-skip`, `agent-adopt`), and put every issue in a milestone with no assignee, or it is never picked | `lib.sh` |
| 12 | Have a `deploy.yml` that accepts `workflow_dispatch` inputs `ref`/`skip_tests`, plus a health URL. Without them the first merge halts every lane | `run.sh`, `run.sh` |
| 13 | Run `orchestrator-install.sh`. It includes a one-time migration from an older layout | `orchestrator-install.sh` |
| 14 | Run gates G1–G4 by hand as root | `orchestrator-install.sh` |
| 15 | Console: aaPanel Apache, certbot, DNS for a hostname that is hardcoded, and a frontend you built yourself | `console-install.sh` |
| 16 | Set the console password, open the console, raise `agents` | `console/bin/passwd.mjs`, `lib.sh` |

A second repo goes through `instance-install.sh`, which accepts exactly one hardcoded instance name (`deploy/instance-install.sh`).

**Assumptions that only hold on the author's box**

- **Paths and names baked in:**
  - `/opt/<name>-agent`, `/var/lib/<name>-ops`, `/home/<name>-agent` (`lib.sh`)
  - the unit, slice and group names, slices s1–s5
  - the slot-to-instance map: slots 1–3 for one instance, 4–5 for the next, 9 for the gates (`instance-install.sh`)
  - an `agents` maximum of 3 (`lib.sh`; SCHEMA §0 also says "K is 1, 2 or 3")
- **Host-specific security config:**
  - the server's own public IP in the sandbox deny list (`sandbox.sh`)
  - a second instance's `/etc` directory named in `InaccessiblePaths` (`sandbox.sh`)
  - a security comment that names the box's other tenants (`sandbox.sh`)
- **The control panel:** aaPanel paths `/www/server/...` in `console-install.sh` and `deploy/ops/pg-watchdog.sh`. All of `deploy/ops/` guards one production database and the author's disk. `alert.sh` defaults to the author's ops repo.
- **The console's identity:**
  - the console origin `https://<host>` (`console/server.mjs`, `systemd/*-console.service`)
  - the `__Host-` cookie, which requires HTTPS or localhost (SCHEMA §5)
- **Language:**
  - about 87 user-facing strings in Indonesian in `run.sh`, `lib.sh` and `sync.sh`, for example `run.sh` and `lib.sh`. These reach GitHub comments (`run.sh`) and the console.
  - all of `prompts/`
  - 54 occurrences across 16 files under `console/`
- **Time zone and locale:** `Asia/Jakarta` and `id-ID` in `console/lib/metrics.mjs`, `web/src/lib/format.ts` and `web/src/lib/depmap.ts`.
- **Model ids:** the grammar only accepts `opencode/` and `opencode-go[@N]/` (`lib.sh`). The default model is one specific free model (`lib.sh`).
- **Protected paths:** `.github/|deploy/` is hardcoded (`run.sh`, `run.sh`). It should be repo config.
- **Merge is automatic:** merge happens on green CI plus the agent's own review label (`run.sh`). There is no "PR only" mode, and no human approval is required.

**What is already good and should be kept:**

- The file contract in `contracts/SCHEMA.md`: one writer per file, validated, atomic writes.
- A tested bash core: `orchestrator/test/run-all.sh` runs on any machine with bash and jq, with no root.
- The trust split. Root holds the token, the sandbox holds nothing, and commits leave the sandbox as bundles.
- A working simulator (`console/dev/simulate.mjs`) and a mock API (`console/web/dev/mock-api.ts`). Demo mode is about 80% there.

## 2. What the terminal cannot do today

| Want | Today |
|---|---|
| See status | `jq` on `ui/slots/K.json` as a member of the ops group, or open the console |
| Tail a lane | Find `/var/log/<name>-agent/issue-N-<ts>-sK/` and read raw opencode JSONL |
| Pause or resume, queue or skip | Hand-edit `ctl/control.json`. A malformed edit falls back to last-good without telling you |
| Steer or stop | Hand-write `ctl/interrupt-K.json` with the current `run_id` |
| Acknowledge a halt | Edit `resume_ack` with the halt's id |
| See spend | `jq` over the root-only `spend.jsonl` |
| Ask "why isn't #12 picked?" | Read `ui/github.json` reasons, which are in Indonesian |
| Do a dry run | `DRY_PICK=1 run.sh --slot K` needs root and the token, and only prints the pick. There is no plan-only mode |
| Try it with no credentials | Two terminals plus `npm ci` of a web package whose dev dependencies include Playwright. None of it is documented |
| Check the setup | G1–G4: root only, on the box, and they assume lanes 1–3 |
| Upgrade, uninstall, add a repo | Re-run the installer, which has no version. There is no uninstall. Adding a repo works for one name only |

## 3. Target CLI

**Recommendation: one npm package, `factory`, that wraps the bash engine.**

- Node 22 is already a hard requirement.
- The console backend has zero runtime dependencies, and the Svelte bundle ships prebuilt.
- `npx factory demo` would work on Linux, macOS and Windows.
- The bash core stays the engine on Linux, unchanged in spirit: paths come from config instead of defaults.
- The CLI is a second client of the SCHEMA files. It reads `ui/` and writes `ctl/` through the same validators the console uses (`console/lib/control.mjs`).

Rejected alternatives:

- Go or Rust rewrite: it discards about 3.7k tested lines, and you would still ship Node for the console.
- A pure bash CLI: no Windows or macOS demo, and weak TTY and JSON handling.
- Python: a third runtime.

### Command surface

```
factory demo [--speed 4] [--no-open]      simulator + console on 127.0.0.1, zero credentials
factory init                              interactive setup (TTY); flags-only otherwise
factory doctor [--deep] [--json]          checks with a fix command per failure; --deep = G1–G4
factory up [--lanes N] / down [--drain]   start/stop lanes (systemd units or containers)
factory status [--watch] [--json]         lanes, stage, issue, elapsed, model, spend today, halt
factory logs <lane> [-f] [--raw]          pretty events (reuse console/lib/activity.mjs)
factory issues [--json] / factory why <n> pick order and the reason each issue is or isn't eligible
factory queue|skip|unskip <n>
factory pause | resume | ack              ack = acknowledge the current halt
factory steer <lane|#n> "msg" / factory stop <lane> [--skip]
factory spend [--json]                    per account, per window, vs budget
factory run <n> --dry-run[=pick|plan]     plan = run the plan turn, print it, push nothing
factory console [--port]                  serve the console on loopback (token in URL)
factory upgrade | uninstall
```

`init` does the following:

- Detects `gh auth status`, `opencode`, systemd or podman/docker, and the repo from `git remote`.
- Offers to create a fine-grained token, and warns before reusing `gh auth token`, which is broad.
- Creates the labels, after confirmation.
- Writes both config files.
- Ends with `next: factory doctor`.

### clig.dev rules applied

- **Output streams:** data goes to stdout, messages to stderr.
- **JSON:** every read command takes `--json`, emitting the SCHEMA shapes with their `v`.
- **Exit codes:** 0 ok, 1 failure, 2 usage, 3 not configured (prints `run: factory init`), 4 halted, 5 budget exhausted.
- **Prompts:** never prompt when stdin is not a TTY or `--no-input` is set. In that case, fail and name the missing flag. `--yes` confirms destructive steps.
- **Color:** honor `NO_COLOR`, `--no-color` and `TERM=dumb`.
- **Progress:** spinners only on a TTY, used for clone, `doctor --deep` and `up`.
- **Errors:** every error states what happened, why, and the exact command that fixes it.
- **Time:** shown in the local time zone; `--utc` to override.
- **Language:** English throughout.

### Config: two TOML files, env generated

- **Repo policy, checked in:** `.factory.toml` in the repo. The agent obeys it and reviewers can read it:
  - `verify.steps = ["npm ci", "npm test"]`, which replaces `VERIFY_KIND`
  - `protected_paths`, `migrations_dir`
  - `pick.label = "factory"`, an opt-in label that replaces the milestone rule
  - `merge = "never" | "on-green"`, default `never`
  - `deploy.workflow`, `deploy.health_url`, both optional
  - `services.postgres = true`
  - `instructions = ["AGENTS.md"]`
- **Operator settings, on the host:** `~/.config/factory/<name>.toml`, or `/etc/factory/<name>.toml` in system mode. They cover:
  - the repo
  - the token source: a file path or the OS keychain, never the value itself
  - lanes, models
  - budgets per account and window
  - runtime
- **Env generated:** the CLI writes the systemd `EnvironmentFile` from these two files. Nobody edits env by hand.

Rejected alternatives:

- Env only: no lists or tables, and there is no place for comments that survive.
- YAML: indentation and type-coercion traps, for no gain.

### Runtimes

- **`systemd`, Linux with root:** the current hardened path, made generic. `factory up` creates the user, directories, units and slices, and installs `gh` and `opencode` at pinned versions with checksums. This is the reference.
- **`container`, rootless Podman preferred, Docker accepted.** The work is the seam:
  - Lanes are containers started with `--cap-drop=ALL`, a read-only rootfs, a per-lane volume, and memory and CPU limits. No token goes in.
  - The controller runs on the host.
  - Postgres becomes a sidecar container.
  - `sb`/`isb` (`run.sh`) are already a single seam, but systemd leaks through it in four places, and each needs a driver call. These are the CPU probe in the watchdog (`run.sh`), Postgres started via `systemd-run` (`run.sh`), `soft_kill` on the unit's main PID (`run.sh`), and lane cleanup by stopping the slice.
- **macOS dev mode:** `factory run <n>` in the foreground with one lane on the container runtime. The 2-minute timer becomes a supervisor loop inside `factory up`.

## 4. Phases

### Phase 0: a credible public repo (about 7 days)

- **De-personalize (2d):**
  - Remove the hardcoded repo, hosts, IP, aaPanel paths and the second-instance names.
  - Move `deploy/ops/` out of the repo; it is host-specific.
  - Make the time zone and locale follow the browser.
- **Language (1.5d):**
  - Translate the strings in the scripts and the console to English.
  - Rewrite the prompts to be generic. Repo-specific rules come from the repo's own `AGENTS.md` or `CONTRIBUTING.md`.
- **`npx factory demo` (2d):**
  - Package the server, the prebuilt `public/`, the simulator and the fixtures.
  - Add a loopback-only demo auth that prints a one-time URL. Today the server refuses to start without `/etc/.../secret` (`console/server.mjs`).
  - Verify it on Windows, macOS and Linux.
- **Safe defaults (1d):** `merge = "never"`, deploy off, opt-in label, free models only, one lane.
- **Docs and CI (0.5d):**
  - A README with the demo in one line, plus "what it can do to your repo and what it costs".
  - `SECURITY.md` with the threat model, and a LICENSE.
  - CI runs `orchestrator/test/run-all.sh` and the console tests.

### Phase 1: first PR on a stranger's repo in under 30 minutes on a fresh Ubuntu VPS (about 15 days)

- The CLI commands in §3, using the systemd runtime (6d).
- Two TOML files and the env generator. Replace `VERIFY_KIND` with generic `verify.steps`. Make deploy and health optional, and add PR-only mode (3d).
- Parameterize the user, group and unit names. Allow any number of instances, with automatic slot allocation, which removes the single-name `instance-install.sh` (2d).
- `doctor`, including a portable port of G1–G4 (2d).
- `factory console` on loopback, plus a generic Caddy or nginx example for remote access (1d).
- `upgrade` and `uninstall` (1d).

### Phase 2: no root, macOS, more users (about 18 days)

- A sandbox driver interface and the container runtime, with a lane image and a Postgres sidecar (8d).
- A model id grammar and spend ledger that are not tied to one vendor. The `lib.sh` regex and the Go-only budgets become per-provider (4d).
- Webhook notifications, replacing the alerts filed as GitHub issues (2d).
- A GitHub App as an alternative to a PAT (4d).

### The three riskiest parts

1. **Running untrusted model output.**
   - **Today's protections:** systemd hardening, an IP deny list, no secrets in the sandbox, bundle export, and root never reads the agent's files.
   - **New exposure in public use:**
     - (a) Issue text from strangers is a prompt-injection channel. Only pick issues whose opt-in label was added by someone with write access, checked through the timeline API.
     - (b) Agent branches are pushed to the base repo, so its `pull_request` CI runs with the repo's secrets. A test the agent writes can read them. `protected_paths` stops edits to workflows, not code that runs inside them. Offer push-to-fork, or require that secrets sit behind protected environments, and have `doctor` check it.
     - (c) The sandbox has open egress, so a private repo's code can leave the machine.
     - (d) The container runtime is weaker than systemd unless it is rootless Podman. Mounting the Docker socket is root on the host, and the docs must say so.
2. **Tokens and credentials.**
   - The PAT is long-lived and can merge.
   - Default to fine-grained tokens scoped to one repo, with contents, PRs and issues only.
   - Never store the value in TOML. Use the keychain in user mode, a 0600 root file in system mode, and systemd `LoadCredential` for model keys.
   - Redact tokens in logs and in `--json` output.
   - `sync.sh` already halts when an opencode key shows up on the agent's side (`sync.sh`). Keep that check and extend it to every provider.
3. **Cost runaway.**
   - Budgets exist only for paid Go accounts. A comment records a ledger gap of about $6/week against the provider's own count (`lib.sh`).
   - Paid models should require an explicit budget in config, and the halt-on-unexpected-cost rule should stay.
   - Cost also hides outside model spend:
     - 20-hour unit timeouts and 300-minute turns
     - CI minutes from fix rounds and reruns
     - PR volume
   - Add caps on open agent PRs, CI reruns per day, and wall-clock time per issue. `factory spend` must show all of them, not only dollars.
