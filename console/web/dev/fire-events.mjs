// DEV ONLY. Appends crafted opencode events to a lane's current turn file in .sim, so each action
// type can be staged on demand:   node dev/fire-events.mjs <slot 1..3> <type[,type...]> [gapMs]
// types: read edit write test build bash grep glob list task webfetch text step error toolerror
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.sim");
const slot = Number(process.argv[2] ?? 1);
const types = (process.argv[3] ?? "edit").split(",");
const gap = Number(process.argv[4] ?? 0);
const s = JSON.parse(fs.readFileSync(path.join(SIM, "ui", "slots", `${slot}.json`), "utf8"));
const file = s.turn?.events;
if (!file) { console.error("slot", slot, "has no running turn"); process.exit(2); }

const tool = (name, input, status = "completed") => ({ type: "tool_use", part: { type: "tool", tool: name, state: { status, input, title: name } } });
const MAKE = {
  read: () => tool("read", { filePath: "/home/factory/work/docs/formulation/grid_power.md" }),
  edit: () => tool("edit", { filePath: "/home/factory/work/crates/shop-api/src/db.rs" }),
  write: () => tool("write", { filePath: "/home/factory/work/crates/shop-core/src/new.rs" }),
  test: () => tool("bash", { command: "cargo test -p shop-core" }),
  build: () => tool("bash", { command: "cargo build --workspace --locked" }),
  bash: () => tool("bash", { command: "git status --short" }),
  grep: () => tool("grep", { pattern: "latitude|longitude" }),
  glob: () => tool("glob", { pattern: "**/*.rs" }),
  list: () => tool("list", { path: "crates" }),
  task: () => tool("task", { description: "survey the weather module" }),
  webfetch: () => tool("webfetch", { url: "https://re.jrc.ec.europa.eu/pvg_tools" }),
  text: () => ({ type: "text", part: { type: "text", text: "Writing notes on the approach." } }),
  step: () => ({ type: "step_finish", part: { type: "step-finish", tokens: { input: 1200, output: 340, reasoning: 0, cache: { read: 9000, write: 0 } }, cost: 0 } }),
  error: () => ({ type: "error", error: { name: "ApiError", data: { message: "rate limited" } } }),
  toolerror: () => tool("bash", { command: "cargo test" }, "error"),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const t of types) {
  const mk = MAKE[t];
  if (!mk) { console.error("unknown type", t); process.exit(2); }
  fs.appendFileSync(file, JSON.stringify({ ...mk(), timestamp: Date.now(), sessionID: s.session ?? "ses_dev" }) + "\n");
  if (gap) await sleep(gap);
}
