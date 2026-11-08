#!/usr/bin/env node
// Plays the orchestrator's side of contracts/SCHEMA.md so the console can be built and
// tested without the server: lanes move through every stage, real opencode events are
// replayed into turn.events files, CI checks progress, issues merge, and the simulator
// obeys ctl/control.json and ctl/interrupt-K.json the way root would.
//
//   node console/dev/simulate.mjs --dir .sim [--speed 4] [--halt-after 120] [--seed 7]
//
// Point the backend at it: HC_UI_DIR=.sim/ui HC_CTL_DIR=.sim/ctl HC_LOG_DIR=.sim/log
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const ROOT = path.resolve(args.dir ?? ".sim");
const SPEED = Number(args.speed ?? 1);
const HALT_AFTER = args["halt-after"] ? Number(args["halt-after"]) : null;
let seed = Number(args.seed ?? 7);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, "../../contracts/fixtures");
const UI = path.join(ROOT, "ui"), CTL = path.join(ROOT, "ctl"), LOG = path.join(ROOT, "log");

// ---------------------------------------------------------------- io
const now = () => Math.floor(Date.now() / 1000);
const iso = (s = now()) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
function writeJson(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  // Windows refuses a rename onto a file another process has open (the dev mock reads these
  // every second): EPERM/EBUSY. Retry briefly, then skip this write; the next tick rewrites it.
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "EACCES") throw e;
      const until = Date.now() + 20; while (Date.now() < until) { /* spin 20 ms */ }
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
const appendStat = (o) => fs.appendFileSync(path.join(UI, "stats.jsonl"), JSON.stringify({ ts: now(), ...o }) + "\n");

// ---------------------------------------------------------------- setup
fs.mkdirSync(path.join(UI, "slots"), { recursive: true });
fs.mkdirSync(CTL, { recursive: true });
fs.mkdirSync(LOG, { recursive: true });
for (const f of ["github.json", "models.json", "consumed.json", "stats.jsonl"])
  if (!fs.existsSync(path.join(UI, f))) fs.copyFileSync(path.join(FIX, "ui", f), path.join(UI, f));
if (!fs.existsSync(path.join(CTL, "control.json"))) fs.copyFileSync(path.join(FIX, "ctl", "control.json"), path.join(CTL, "control.json"));
const EVENTS = fs.readFileSync(path.join(FIX, "log", "plan-0.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

let github = readJson(path.join(UI, "github.json"));
let models = readJson(path.join(UI, "models.json"));
let consumed = readJson(path.join(UI, "consumed.json"), {});
const started = now();

// ---------------------------------------------------------------- lanes
// Stage script: [stage, seconds, sub-steps]. Turns replay events while they run.
const SCRIPT = [
  ["pick", 3], ["plan", 24, { turn: "plan" }], ["build", 50, { turn: "build" }],
  ["build", 14, { turn: "complete1", sub: "complete 1/4" }], ["build", 12, { turn: "complete2", sub: "complete 2/4" }],
  ["verify", 14], ["review", 22, { turn: "review" }], ["verify", 8], ["pr", 5], ["ci", 30], ["merge", 5], ["deploy", 18], ["live", 6],
];
const blank = (k) => ({
  v: 1, slot: k, run_id: null, state: "parked", stage: null, sub: "", issue: null, pr: null, model: null, session: null,
  turn: null, stage_started: null, issue_started: null, tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0 },
  requirements: null, ci: null, steer: { pending: null, last: null }, interrupt: null, note: "", effective_agents: 1,
  log_dir: null, updated: now(),
});
const lanes = [1, 2, 3].map((k) => ({ s: blank(k), step: -1, stepEnds: 0, eventIdx: 0, nextEvent: 0, holdUntil: 0, lastInterrupt: null }));

function control() {
  const c = readJson(path.join(CTL, "control.json"), {});
  return {
    agents: Number.isInteger(c.agents) ? Math.max(0, Math.min(3, c.agents)) : 1,
    models: Array.isArray(c.models) && c.models.length ? c.models : ["opencode/deepseek-v4.1-flash-free"],
    paused: c.paused === true, queue: Array.isArray(c.queue) ? c.queue : [], skip: Array.isArray(c.skip) ? c.skip : [],
    resume_ack: c.resume_ack ?? null,
  };
}
function halted(ctl) {
  const h = readJson(path.join(UI, "halt.json"));
  return h && ctl.resume_ack !== h.id ? h : null;
}
function setClass(n, cls, extra = {}) {
  const i = github.issues.find((x) => x.n === n);
  if (i) Object.assign(i, { class: cls, ...extra });
}
function reorder(ctl) {
  let order = 1;
  for (const i of github.issues) if (i.class === "queued" || i.class === "eligible") i.order = null;
  const active = ctl.queue.filter((q) => !consumed[q.n] || consumed[q.n] < q.at).map((q) => q.n);
  for (const n of active) { const i = github.issues.find((x) => x.n === n && !["running"].includes(x.class)); if (i) { i.class = "queued"; i.order = order++; } }
  for (const i of github.issues.filter((x) => x.class === "eligible").sort((a, b) =>
    (a.milestone ?? "M9").localeCompare(b.milestone ?? "M9") || (a.priority ?? "P9").localeCompare(b.priority ?? "P9") || a.n - b.n))
    i.order = order++;
  for (const n of ctl.skip) setClass(n, "skipped", { order: null, reason: "control.skip" });
}
function pickIssue(ctl, k) {
  reorder(ctl);
  const next = github.issues.filter((i) => i.order != null && !ctl.skip.includes(i.n)).sort((a, b) => a.order - b.order)[0];
  if (!next) return null;
  if (next.class === "queued") { consumed[next.n] = iso(); writeJson(path.join(UI, "consumed.json"), consumed); }
  setClass(next.n, "running", { order: null, reason: `lane ${k}`, claimed_by: k });
  return next;
}
function cooling(m) { const c = models.cooldown?.[m]; return c && c.until > now(); }

const REQ_POOL = [
  "Add types and serde for the discount rules config", "Compute the order total per line with tax and rounding",
  "Feed the result into the daily sales rollup", "Add the API endpoint and input validation", "Report problems in warnings[], no silent clamp",
  "Write oracle tests against the pricing fixtures", "Update the domain docs in CONTEXT.md", "Add a migration for the new table",
  "Show the result on the cart page", "Add a regression test for the empty-string edge case"];
const FILE_POOL = ["crates/shop-core/src/discounts.rs", "crates/shop-core/src/pricing.rs", "crates/shop-api/src/routes/orders.rs",
  "crates/shop-api/migrations/0042_discounts.sql", "frontend/src/pages/cart.astro", "crates/shop-core/tests/pricing_oracle.rs"];
function writeRunMeta(L, issue) {
  const dir = L.s.log_dir;
  const total = 6 + Math.floor(rand() * 5);
  L.reqList = Array.from({ length: total }, (_, i) => REQ_POOL[i % REQ_POOL.length] + (i >= REQ_POOL.length ? ` (${i + 1})` : ""));
  L.doneCount = 0;
  writeJson(path.join(dir, "issue.json"), { number: issue.n, title: issue.title, state: "OPEN", labels: [{ name: "agent" }, { name: issue.milestone ?? "M2" }],
    milestone: { title: issue.milestone ?? "M2" }, body: "Simulated: the issue body lives on GitHub.", comments: [] });
}
function writePlan(L) {
  writeJson(path.join(L.s.log_dir, "plan.json"), { decision: "go", slice: `First slice for ${L.s.issue.tag ?? "issue"}: core first, API after`,
    requirements: L.reqList, files: FILE_POOL.slice(0, 3 + Math.floor(rand() * 3)), tests: "cargo test -p shop-core; cargo test -p shop-api --locked" });
}
function writeChecklist(L) {
  const done = L.s.requirements?.done ?? 0;
  writeJson(path.join(L.s.log_dir, "checklist.json"), L.reqList.map((item, i) => (
    i < done ? { item, done: true, evidence: `${FILE_POOL[i % FILE_POOL.length]}:${40 + i * 17} test_${i + 1}` } : { item, done: false })));
}

function startIssue(L, ctl, k) {
  const issue = pickIssue(ctl, k);
  if (!issue) { Object.assign(L.s, { state: "idle", stage: null, note: "no issue to pick up" }); return; }
  const ts = iso().replace(/[-:]/g, "");
  const logDir = path.join(LOG, `issue-${issue.n}-${ts}-s${k}`);
  fs.mkdirSync(logDir, { recursive: true });
  Object.assign(L.s, {
    run_id: crypto.randomBytes(16).toString("hex"), state: "running", issue: { n: issue.n, title: issue.title, tag: issue.tag, family: issue.family, url: issue.url },
    pr: null, model: ctl.models.find((m) => !cooling(m)) ?? ctl.models[0], session: "ses_" + crypto.randomBytes(12).toString("hex").slice(0, 24),
    issue_started: now(), tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0 },
    requirements: null, ci: null, steer: { pending: null, last: null }, note: "", log_dir: logDir,
  });
  writeRunMeta(L, issue);
  L.step = -1; enterStep(L);
}
function enterStep(L) {
  // Close the previous turn with a call line.
  if (L.s.turn) appendStat({ issue: L.s.issue.n, slot: L.s.slot, kind: "call", phase: L.s.turn.phase, model: L.s.model, rc: 0,
    model_error: false, rate_limited: false, cost: 0, secs: now() - L.s.turn.started, tokens: L.turnTokens });
  const prev = SCRIPT[L.step];
  if (prev && (!SCRIPT[L.step + 1] || SCRIPT[L.step + 1][0] !== prev[0]))
    appendStat({ issue: L.s.issue.n, slot: L.s.slot, kind: "stage", stage: prev[0], secs: now() - L.s.stage_started, result: "ok" });
  L.step++;
  const step = SCRIPT[L.step];
  if (!step) return finishIssue(L);
  const [stage, secs, opt = {}] = step;
  if (stage !== L.s.stage) L.s.stage_started = now();
  L.s.stage = stage; L.s.sub = opt.sub ?? ""; L.stepEnds = Date.now() + (secs * 1000) / SPEED;
  L.s.turn = null; L.turnTokens = { input: 0, output: 0, reasoning: 0, cache_read: 0 };
  if (opt.turn) {
    const file = path.join(L.s.log_dir, `${opt.turn}-0.jsonl`);
    fs.writeFileSync(file, "");
    L.s.turn = { phase: opt.turn, started: now(), events: file };
    L.eventIdx = 0; L.nextEvent = Date.now();
    if (L.s.steer.pending) {   // a steer that waited for the next turn is delivered now
      emitText(L, `Human steer received: ${L.s.steer.pending.message}`);
      L.s.steer = { pending: null, last: { ...L.s.steer.pending, applied_at: now(), outcome: "applied" } };
      appendStat({ issue: L.s.issue.n, slot: L.s.slot, kind: "steer", phase: opt.turn, outcome: "applied" });
    }
  }
  if (stage === "plan") writePlan(L);
  if (stage === "verify" && L.s.requirements && L.s.requirements.done < L.s.requirements.total) { L.s.requirements.done = L.s.requirements.total; writeChecklist(L); }
  if (stage === "build" && !L.s.requirements) { L.s.requirements = { total: L.reqList.length, done: 0 }; writeChecklist(L); }
  if (stage === "pr") L.s.pr = { n: 140 + Math.floor(rand() * 60), url: "https://github.com/acme/shop/pull/0", head: crypto.randomBytes(6).toString("hex") };
  if (stage === "ci") L.s.ci = { head: L.s.pr.head, checks: [
    { name: "Build and test", status: "queued", conclusion: null },
    { name: "Integration tests", status: "queued", conclusion: null },
    { name: "Lint", status: "completed", conclusion: "skipped" }] };
  if (stage === "deploy") L.s.ci = null;
}
function finishIssue(L) {
  appendStat({ issue: L.s.issue.n, slot: L.s.slot, kind: "outcome", outcome: "merged", model: L.s.model, url: L.s.pr?.url, sha: crypto.randomBytes(6).toString("hex") });
  github.issues = github.issues.filter((i) => i.n !== L.s.issue.n);
  Object.assign(L.s, { state: "idle", stage: null, sub: "", issue: null, pr: null, turn: null, run_id: null, requirements: null, ci: null, note: "" });
  L.holdUntil = Date.now() + 3000 / SPEED;
}
function emitText(L, text) {
  if (!L.s.turn) return;
  fs.appendFileSync(L.s.turn.events, JSON.stringify({ type: "text", timestamp: Date.now(), sessionID: L.s.session,
    part: { type: "text", text, sessionID: L.s.session } }) + "\n");
}
function replayEvent(L) {
  const src = EVENTS[L.eventIdx++ % EVENTS.length];
  const e = JSON.parse(JSON.stringify(src));
  e.timestamp = Date.now(); e.sessionID = L.s.session; if (e.part) e.part.sessionID = L.s.session;
  if (e.part?.state?.input?.filePath) e.part.state.input.filePath = e.part.state.input.filePath.replace("/home/factory/work/", `/home/factory/s${L.s.slot}/work/`);
  fs.appendFileSync(L.s.turn.events, JSON.stringify(e) + "\n");
  if (e.type === "step_finish" && e.part?.tokens) {
    const t = e.part.tokens;
    for (const [k, v] of [["input", t.input], ["output", t.output], ["reasoning", t.reasoning], ["cache_read", t.cache?.read]]) {
      L.s.tokens[k] += v ?? 0; L.turnTokens[k] += v ?? 0;
    }
  }
  if (e.type === "tool_use" && L.s.requirements && L.s.stage === "build" && rand() < 0.15 && L.s.requirements.done < L.s.requirements.total)
  { L.s.requirements.done++; writeChecklist(L); }
}
function handleInterrupt(L, ctl) {
  const f = path.join(CTL, `interrupt-${L.s.slot}.json`);
  let st; try { st = fs.lstatSync(f); } catch { return; }
  if (!st.isFile() || st.size > 65536) return;
  const it = readJson(f);
  if (!it || it.id === L.lastInterrupt || it.run_id !== L.s.run_id || !L.s.run_id) return;
  L.lastInterrupt = it.id;
  const inCritical = ["merge", "deploy"].includes(L.s.stage);
  L.s.interrupt = { last_id: it.id, action: it.action, handled_at: now() };
  if (it.action === "stop") {
    if (inCritical) { L.s.sub = "stop deferred"; L.deferredStop = true; return; }
    return stopLane(L);
  }
  if (it.action === "steer" && typeof it.message === "string") {
    const pending = { id: it.id, message: it.message.slice(0, 2000), at: it.at ?? iso() };
    if (L.s.turn && !inCritical) {
      L.s.sub = "steer"; emitText(L, `Human steer received: ${pending.message}`);
      L.s.steer = { pending: null, last: { ...pending, applied_at: now(), outcome: "applied" } };
      appendStat({ issue: L.s.issue.n, slot: L.s.slot, kind: "steer", phase: L.s.turn.phase, outcome: "applied" });
    } else L.s.steer.pending = pending;
  }
}
function stopLane(L) {
  L.s.state = "stopping"; L.s.note = "stopping the sandbox";
  setTimeout(() => {
    appendStat({ issue: L.s.issue?.n ?? 0, slot: L.s.slot, kind: "stage", stage: L.s.stage, secs: now() - (L.s.stage_started ?? now()), result: "stopped" });
    appendStat({ issue: L.s.issue?.n ?? 0, slot: L.s.slot, kind: "outcome", outcome: "stopped", model: L.s.model });
    if (L.s.issue) setClass(L.s.issue.n, "eligible", { claimed_by: null, reason: "" });
    Object.assign(L.s, { state: "stopped", stage: null, sub: "", turn: null, run_id: null, ci: null, note: "stopped from the console" });
    L.holdUntil = Date.now() + 60000 / SPEED;
  }, 1200 / SPEED);
  L.s.state = "stopping";
}

// ---------------------------------------------------------------- tick
let lastRate = Date.now();
function tick() {
  const ctl = control();
  if (HALT_AFTER && now() - started >= HALT_AFTER && !fs.existsSync(path.join(UI, "halt.json")) && !globalThis.__halted) {
    globalThis.__halted = true;
    writeJson(path.join(UI, "halt.json"), { id: `${now()}-deploy`, reason: "deploy 1a2b3c4 failed (failure)", at: now(), issue_url: "https://github.com/acme/shop/issues/150" });
  }
  const halt = halted(ctl);
  // Rate limits: roughly one 45 s cooldown every 3 minutes of simulated time on the first model.
  if (Date.now() - lastRate > 180000 / SPEED) {
    lastRate = Date.now();
    models.cooldown = { [ctl.models[0]]: { until: now() + Math.ceil(45 / SPEED), reason: "rate_limit" } };
    writeJson(path.join(UI, "models.json"), { ...models, updated: now() });
  }
  const allCooling = ctl.models.every(cooling);
  const effective = allCooling ? Math.min(1, ctl.agents) : ctl.agents;

  for (const L of lanes) {
    const k = L.s.slot;
    L.s.effective_agents = effective;
    handleInterrupt(L, ctl);
    if (L.s.state === "stopping") { L.s.updated = now(); continue; }
    if (halt) { if (L.s.state !== "parked") { L.s.state = "halted"; L.s.note = halt.reason; } L.s.updated = now(); continue; }
    if (L.s.state === "halted") L.s.state = L.s.issue ? "running" : "idle";
    const busy = L.s.issue && ["running", "draining", "backoff"].includes(L.s.state);
    if (!busy) {
      if (Date.now() < L.holdUntil) { L.s.updated = now(); continue; }
      if (k > effective) Object.assign(L.s, blank(k), { effective_agents: effective, state: "parked" });
      else if (ctl.paused) Object.assign(L.s, { state: "idle", stage: null, note: "paused from the console" });
      else if (allCooling) Object.assign(L.s, { state: "backoff", note: `all models cooling down until ${iso(Math.min(...ctl.models.map((m) => models.cooldown?.[m]?.until ?? now())))}` });
      else startIssue(L, ctl, k);
    } else {
      L.s.state = k > effective ? "draining" : "running";
      if (L.s.turn && Date.now() >= L.nextEvent) { replayEvent(L); L.nextEvent = Date.now() + (700 + rand() * 1400) / SPEED; }
      if (L.s.stage === "ci" && L.s.ci) {
        const left = L.stepEnds - Date.now();
        for (const c of L.s.ci.checks) if (c.status !== "completed") {
          c.status = left < 20000 / SPEED ? "in_progress" : "queued";
          if (left < 3000 / SPEED) Object.assign(c, { status: "completed", conclusion: "success" });
        }
      }
      if (Date.now() >= L.stepEnds) {
        if (L.deferredStop && !["merge", "deploy"].includes(SCRIPT[L.step + 1]?.[0])) { L.deferredStop = false; enterStep(L); if (L.s.issue) stopLane(L); }
        else enterStep(L);
      }
    }
    L.s.updated = now();
  }
  for (const L of lanes) writeJson(path.join(UI, "slots", `${L.s.slot}.json`), L.s);
  reorder(ctl);
  github.updated = now(); github.health = { ok: !halt, checked: now() };
  writeJson(path.join(UI, "github.json"), github);
}
tick();
setInterval(tick, 1000);
console.log(`simulating into ${ROOT} at ${SPEED}x — ui/ ctl/ log/ ready`);
