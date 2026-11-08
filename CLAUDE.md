# factory: notes for coding agents

Read `contracts/SCHEMA.md` first. It is the only interface between the two halves, and every
file in it has exactly one writer.

## Map
- `orchestrator/` bash engine, runs as root on Linux + systemd. `run.sh` = one lane, one unit of
  work; `sync.sh` = GitHub and model state every minute; `lib.sh` shared; `sandbox.sh` the only
  way agent code runs. Tests: `orchestrator/test/run-all.sh` (bash + jq, no root; they refuse root).
- `console/` web console. `server.mjs` + `lib/` = Node built-ins only, tests `cd console && npm test`.
  `web/` = Svelte 5 + Vite, `npm run check && npm test && npm run build` (outputs to `console/public`).
- `bin/factory.mjs` the CLI (`demo`, `doctor`, `status`). Tests `node --test bin/test/*.test.mjs`.
- `console/dev/simulate.mjs` plays the engine's side of the contract; `factory demo` runs it.
- `deploy/` install scripts (root). `docs/roadmap.md` what is planned and why.

## Rules
- A new file in `ui/` or `ctl/`, or a new field: change `contracts/SCHEMA.md`, the writer, the
  validator, and a fixture in `contracts/fixtures/` in the same change.
- Fixtures are synthetic (a made-up repo `acme/shop`). Never paste real issue titles, logs or
  code from a private repository into them.
- Everything a human reads (GitHub comments, console text, CLI output) is English.
- CI (`.github/workflows/test.yml`) runs all three test suites; keep it green.
