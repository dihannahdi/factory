# Security

factory runs code that a language model wrote, on your machine, against your repository. Read
this before you point it at anything you care about.

## What protects you today

- **The agent holds no secrets.** Each lane runs as an unprivileged user inside a transient
  systemd unit (`orchestrator/sandbox.sh`): its own home, a read-only view of `/usr` and `/etc`,
  no access to the token files, the console's config, or the Docker/Postgres/MySQL sockets.
- **Root never runs the agent's code and never reads its files as code.** Commits leave the
  sandbox as a git bundle; root verifies and pushes them.
- **Verification runs in the sandbox too**, with a private network namespace for browser tests.
- **Merging is off by default** (`MERGE_MODE=pr`): the agent opens a PR, gets CI and its own
  review, and stops. A human merges.
- **Paid models need a budget.** Spend is capped per account and per 5 hours / week / month,
  and an unexpected charge halts every lane.

## What does not protect you yet

1. **Issue text is a prompt.** Anyone who can write an issue the agent picks can steer it. Run
   factory only on repositories where you trust everyone who can open or edit eligible issues.
2. **CI runs the agent's code with your repository's secrets.** Agent branches are pushed to the
   base repo, so a test the agent writes runs inside your `pull_request` workflows. Keep deploy
   keys and cloud credentials in protected environments that PR workflows cannot reach.
3. **The sandbox has outbound internet.** A private repository's code can leave the machine.
4. **The GitHub token is long-lived.** Use a fine-grained token scoped to one repository with
   only the permissions listed in [docs/self-hosting.md](docs/self-hosting.md#3-a-token-for-one-repository).

These are the top items on the [roadmap](docs/roadmap.md).

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this
repository ("Security" tab → "Report a vulnerability"). You will get a reply within a week.
