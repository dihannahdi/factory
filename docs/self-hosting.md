# Run factory on your repository

This is the path today: a Linux server with systemd, set up by hand in about fifteen commands.
`factory init` will replace most of it (see [roadmap.md](roadmap.md)). Every step is idempotent,
so you can run any of them again.

Developed and run on Ubuntu. Any distribution with systemd, bash 5 and a recent util-linux should
work; if one does not, please open an issue.

## 1. The machine

```bash
sudo apt-get install -y git jq curl util-linux
# Node 22 or newer at /usr/local/bin/node (the console's unit uses that path)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs
sudo ln -sf "$(command -v node)" /usr/local/bin/node
```

## 2. The sandbox user and its tools

Lanes run as an unprivileged user named `factory`. opencode is installed in that user's home,
which the sandbox puts on its PATH.

```bash
sudo useradd --create-home --shell /bin/bash factory
sudo -u factory -H bash -c 'npm config set prefix ~/.npm-global && npm install -g opencode-ai'
```

The GitHub CLI runs as root only, at a fixed path:

```bash
# install gh from https://cli.github.com (the apt repository is easiest), then:
sudo install -d /opt/factory/bin && sudo ln -sf "$(command -v gh)" /opt/factory/bin/gh
```

## 3. A token for one repository

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
with access to **only the repository factory will work**, and these permissions:

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | push `agent/issue-<n>` branches |
| Pull requests | Read and write | open, comment on, label, and (with `MERGE_MODE=auto`) merge PRs |
| Issues | Read and write | read issues, comment, label, close finished epics |
| Actions | Read and write | read CI job logs, re-run a failed job once, start a deploy workflow (`auto` only) |
| Checks | Read | see each PR's check runs |
| Metadata | Read | required by GitHub |

```bash
sudo install -D -m 600 /dev/stdin /etc/factory/gh-token   # paste the token, then Ctrl-D
```

The agent never sees this file; only root's side uses it.

## 4. Labels in your repository

factory creates `agent-ready` itself. Create the others once:

```bash
for l in agent agent-reviewed agent-failed agent-blocked agent-skip agent-adopt; do
  gh label create "$l" -R owner/name --force
done
```

`agent-skip` is the one you will use by hand: put it on an issue factory should leave alone.

## 5. Install

From a clone of this repository on the server:

```bash
sudo deploy/orchestrator-install.sh
```

The first run creates `/etc/factory/instance.env` and stops. Set `REPO=owner/name` there, read the
other settings (merge mode, how to verify, the server's public IP for the sandbox, models and
money), then run the installer again. It installs the engine to `/opt/factory`, the units and
timers, and the directories, and ends by printing the next step: run the four gates as root
(`/opt/factory/gates/G1.sh` to `G4.sh`). They check the sandbox on your machine: G1 that lanes
are isolated from each other, G2 that opencode runs in a lane and a session resumes in another,
G3 that a stuck turn can be interrupted and continued, G4 that three lanes can call models at once.

## 6. The console

```bash
READONLY=0 sudo deploy/console-install.sh     # asks for an email and a password (12+ characters)
```

It listens on `127.0.0.1:4420`. From your laptop:

```bash
ssh -L 4420:127.0.0.1:4420 your-server     # then open http://127.0.0.1:4420
```

To serve it on a domain behind Apache with a Let's Encrypt certificate, set `HOST_NAME` and
`CERTBOT_EMAIL` (see the top of `deploy/console-install.sh`).

## 7. Start

Lanes start at `agents: 0`, so nothing runs until you say so. In the console, raise **agents**
to 1. Within two minutes lane 1 picks the first eligible issue:

- open, in a milestone, with no assignee;
- not labelled `agent-skip`, `agent-blocked` or `agent-failed`;
- every issue it names in a `Depends on: #n` line is closed.

Start with one lane and a small, well-described issue. Watch it in the console, read the PR it
opens, and raise the lane count once you trust it.

## Paying for steadier models (optional)

Free models on OpenCode Zen change often and get rate-limited. An
[OpenCode Go](https://opencode.ai/go) subscription ($10/month) gives the lanes steadier models.
Put its key in `/etc/opencode/go.key` (owner `root`, group `factory`, mode `0640`; sync refuses a
key file with any other owner or mode), remove the empty `GO_MODELS=` and `GO_ACCOUNTS=` lines from
`/etc/factory/instance.env`, and set `GO_BUDGET_5H`, `GO_BUDGET_WEEK` and `GO_BUDGET_MONTH` at or
under the limits your plan shows. Sync picks it up within a minute; the console's deck shows the
Go models and what each window has spent.

## A second repository

Same machine, same code, its own lanes (slots 4 and 5), state and token:
`orchestrator/instances/blog.env` is the example and `deploy/instance-install.sh` installs it.

## When something is wrong

- `journalctl -u factory@1 -n 50` and `journalctl -u factory-sync -n 50` show the latest runs.
- A halt (an unexpected charge, a failed deploy, a leaked key) stops every lane and opens an
  issue in your repository that says why. Fix the cause, then acknowledge the halt in the
  console.
- Each run's full log, including every model event, is under `/var/log/factory/`.
