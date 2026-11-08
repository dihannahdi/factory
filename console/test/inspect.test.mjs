import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectSlot, loadTurnFile, clearCache, cacheSize, listTurns, MAX_TURN_ITEMS } from "../lib/inspect.mjs";
import { listRuns, getRun, parseId, phaseStage, ID_RE, MAX_RUNS, MAX_REPLAY_ITEMS } from "../lib/replay.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hc-insp-"));
const ev = (type, ts, part = {}, extra = {}) => JSON.stringify({ type, timestamp: ts, sessionID: "ses_x", part, ...extra });
const tool = (ts, name, input, status = "completed") => ev("tool_use", ts, { tool: name, state: { status, input, title: name } });
const writeLines = (file, lines) => fs.writeFileSync(file, lines.join("\n") + "\n");
const T0 = 1792129717; // epoch s of the run start used in the dir names below
const DIR = "issue-24-20261016T055517Z-s1"; // = 1792130117? computed through parseId in tests

function mkRun(root, name = DIR) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const slotOf = (dir, extra = {}) => ({ slot: 1, run_id: "r1", stage: "build", issue: { n: 24, title: "t" }, pr: null, ci: null, turn: null, log_dir: dir, ...extra });

test("inspect: files aggregate edits and reads, strip both work prefixes", () => {
  const root = tmp();
  const dir = mkRun(root);
  const base = 1792130200000;
  writeLines(path.join(dir, "plan-0.jsonl"), [
    tool(base + 1, "read", { filePath: "/home/factory/s1/work/crates/a.rs" }),
    tool(base + 2, "read", { filePath: "/home/factory/work/crates/b.rs" }),
    tool(base + 3, "edit", { filePath: "/home/factory/s1/work/crates/a.rs" }),
  ]);
  writeLines(path.join(dir, "build-0.jsonl"), [
    tool(base + 10, "edit", { filePath: "/home/factory/s1/work/crates/a.rs" }),
    tool(base + 11, "write", { filePath: "/home/factory/s1/work/crates/new.rs" }),
    tool(base + 12, "read", { filePath: "/home/factory/s1/work/crates/a.rs" }),
    tool(base + 13, "edit", { filePath: "/home/factory/s1/work/crates/fail.rs" }, "error"),
    tool(base + 14, "bash", { command: "cargo test" }),
  ]);
  const r = inspectSlot(root, slotOf(dir));
  const f = Object.fromEntries(r.files.map((x) => [x.path, x]));
  assert.deepEqual(Object.keys(f).sort(), ["crates/a.rs", "crates/b.rs", "crates/new.rs"]);
  assert.equal(f["crates/a.rs"].edits, 2);
  assert.equal(f["crates/a.rs"].reads, 2);
  assert.equal(f["crates/a.rs"].last, base + 12);
  assert.equal(f["crates/b.rs"].reads, 1);
  assert.equal(f["crates/new.rs"].edits, 1);
  assert.equal(r.files[0].path, "crates/a.rs", "newest touch first");
  assert.deepEqual(r.turns.map((t) => [t.phase, t.file, t.items]), [["plan", "plan-0.jsonl", 3], ["build", "build-0.jsonl", 5]]);
  assert.equal(r.turns[0].first, base + 1);
  assert.equal(r.turns[1].last, base + 14);
  assert.equal(r.turn, null);
  assert.equal(r.checklist, null);
  assert.equal(r.plan, null);
});

test("inspect: current turn items are capped to the newest 2000, oldest first", () => {
  const root = tmp();
  const dir = mkRun(root);
  const lines = [];
  for (let i = 0; i < MAX_TURN_ITEMS + 50; i++) lines.push(ev("text", 1792130200000 + i, { text: `m${i}` }));
  const file = path.join(dir, "build-0.jsonl");
  writeLines(file, lines);
  const r = inspectSlot(root, slotOf(dir, { turn: { phase: "build", started: 1792130200, events: file } }));
  assert.equal(r.turn.phase, "build");
  assert.equal(r.turn.items.length, MAX_TURN_ITEMS);
  assert.equal(r.turn.items[0].text, "m50");
  assert.equal(r.turn.items.at(-1).text, `m${MAX_TURN_ITEMS + 49}`);
  assert.equal(r.turns[0].items, MAX_TURN_ITEMS + 50);
});

test("inspect: items match the live activity parser; partial last line skipped", () => {
  const root = tmp();
  const dir = mkRun(root);
  const file = path.join(dir, "plan-0.jsonl");
  fs.writeFileSync(file, [ev("text", 5, { text: "halo" }), ev("step_finish", 6, { tokens: { input: 3, output: 4 } })].join("\n") + "\n" + '{"type":"text","timest');
  const d = loadTurnFile(file);
  assert.equal(d.items.length, 2);
  assert.deepEqual(d.items[0], { t: 5, kind: "text", tool: null, target: null, text: "halo", status: null, tokens: null });
  assert.deepEqual(d.items[1].tokens, { in: 3, out: 4 });
});

test("inspect: cache is keyed by size/mtime and re-parses a grown file", () => {
  const root = tmp();
  const dir = mkRun(root);
  const file = path.join(dir, "plan-0.jsonl");
  clearCache();
  writeLines(file, [ev("text", 1, { text: "a" })]);
  const a = loadTurnFile(file);
  assert.equal(loadTurnFile(file), a, "same object while unchanged");
  fs.appendFileSync(file, ev("text", 2, { text: "b" }) + "\n");
  const b = loadTurnFile(file);
  assert.notEqual(b, a);
  assert.equal(b.items.length, 2);
  assert.ok(cacheSize() >= 1);
});

test("inspect: checklist and plan are read when present, null when malformed", () => {
  const root = tmp();
  const dir = mkRun(root);
  fs.writeFileSync(path.join(dir, "checklist.json"), JSON.stringify([{ item: "x", done: true, evidence: "a.rs:1" }]));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ decision: "go", slice: "s", requirements: ["x"], files: [], tests: "t" }));
  let r = inspectSlot(root, slotOf(dir));
  assert.equal(r.checklist[0].item, "x");
  assert.equal(r.plan.decision, "go");
  fs.writeFileSync(path.join(dir, "checklist.json"), '{"not":"an array"}');
  fs.writeFileSync(path.join(dir, "plan.json"), "[1,2]");
  r = inspectSlot(root, slotOf(dir));
  assert.equal(r.checklist, null);
  assert.equal(r.plan, null);
});

test("inspect: path traversal, outside dirs and symlinks are refused", (t) => {
  const root = tmp();
  const outside = tmp();
  const dir = mkRun(root);
  assert.equal(inspectSlot(root, slotOf(null, { log_dir: null })), null);
  assert.equal(inspectSlot(root, slotOf(path.join(root, "..", path.basename(outside)))), null, "dotdot");
  assert.equal(inspectSlot(root, slotOf(outside)), null, "outside the log dir");
  assert.equal(inspectSlot(root, slotOf(root)), null, "the log dir itself");
  assert.equal(inspectSlot(root, slotOf(path.join(dir, "nope"))), null, "missing");
  // a turn file outside the log dir is not served as the current turn
  const stray = path.join(outside, "x.jsonl");
  writeLines(stray, [ev("text", 1, { text: "secret" })]);
  const r = inspectSlot(root, slotOf(dir, { turn: { phase: "plan", started: 1, events: stray } }));
  assert.deepEqual(r.turn.items, []);
});

test("inspect: symlinked run dirs, turn files and json files are refused", (t) => {
  const root = tmp();
  const outside = tmp();
  const dir = mkRun(root);
  const stray = path.join(outside, "x.jsonl");
  writeLines(stray, [ev("text", 1, { text: "secret" })]);
  try {
    fs.symlinkSync(outside, path.join(root, "issue-9-20261016T000000Z-s1"), "dir");
    fs.symlinkSync(stray, path.join(dir, "evil-0.jsonl"));
    fs.symlinkSync(path.join(outside, "x.jsonl"), path.join(dir, "plan.json"));
  } catch { t.skip("symlinks not permitted here"); return; }
  assert.equal(inspectSlot(root, slotOf(path.join(root, "issue-9-20261016T000000Z-s1"))), null, "symlinked run dir");
  assert.deepEqual(listTurns(dir).map((x) => x.file), [], "symlinked turn file ignored");
  assert.equal(inspectSlot(root, slotOf(dir)).plan, null, "symlinked plan.json ignored");
  assert.equal(getRun(root, path.join(root, "stats.jsonl"), "issue-9-20261016T000000Z-s1"), null);
});

// ------------------------------------------------------------------ replay
test("replay: id regex", () => {
  for (const ok of ["issue-24-20261016T055517Z", "issue-24-20261016T055517Z-s1", "issue-1-20260101T000000Z-s3"]) assert.ok(ID_RE.test(ok), ok);
  for (const bad of ["", "issue-24", "issue--20261016T055517Z", "issue-24-20261016T055517Z-s4", "issue-24-20261016T055517Z-s1/", "../issue-24-20261016T055517Z",
    "issue-24-20261016T055517Z-s1\n", "Issue-24-20261016T055517Z", "issue-24-2026101T055517Z"]) assert.ok(!ID_RE.test(bad), JSON.stringify(bad));
  const p = parseId("issue-24-20261016T055517Z-s2");
  assert.equal(p.issue, 24);
  assert.equal(p.slot, 2);
  assert.equal(p.started, Date.UTC(2026, 9, 16, 5, 55, 17) / 1000);
  assert.equal(parseId("issue-24-20261016T055517Z").slot, 1);
});

test("replay: phase to stage mapping", () => {
  const m = { plan: "plan", replan: "plan", build: "build", complete2: "build", "steer-1": "build", "fix-build-1": "verify", "fix-complete1": "verify",
    review: "review", "fix-review-2": "review", merge1: "pr", "fix-merge": "pr", ci1: "ci", "fix-ci-1": "ci", weird: null };
  for (const [k, v] of Object.entries(m)) assert.equal(phaseStage(k), v, k);
});

function runAt(root, issue, startedS, slot = 1) {
  const d = new Date(startedS * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = `issue-${issue}-${d}-s${slot}`;
  return { name, dir: mkRun(root, name) };
}

test("replay: runs are newest first, limited to 50, titles from issue.json", () => {
  const root = tmp();
  const base = 1792000000;
  for (let i = 0; i < 55; i++) {
    const { dir } = runAt(root, 100 + i, base + i * 100);
    if (i === 54) fs.writeFileSync(path.join(dir, "issue.json"), JSON.stringify({ number: 154, title: "[ELE-01] Wiring" }));
    writeLines(path.join(dir, "plan-0.jsonl"), [ev("text", (base + i * 100 + 5) * 1000, { text: "x" })]);
  }
  fs.mkdirSync(path.join(root, "not-a-run"));
  fs.writeFileSync(path.join(root, "issue-1-20260101T000000Z-s1"), "a file, not a dir");
  const { runs } = listRuns(root, path.join(root, "stats.jsonl"));
  assert.equal(runs.length, MAX_RUNS);
  assert.equal(runs[0].issue, 154);
  assert.equal(runs[0].tag, "ELE-01");
  assert.equal(runs[0].title, "[ELE-01] Wiring");
  assert.equal(runs[0].items, 1);
  assert.deepEqual(runs[0].turns, ["plan"]);
  assert.equal(runs[1].title, null);
  assert.ok(runs.every((r, i) => i === 0 || runs[i - 1].started > r.started));
  assert.equal(runs.at(-1).issue, 105);
  assert.equal(listRuns(path.join(root, "missing"), "x").runs.length, 0);
});

test("replay: timeline merges turns with stats stage lines; outcome inside the window only", () => {
  const root = tmp();
  const started = 1792130000;
  const { name, dir } = runAt(root, 24, started);
  const s = (n) => (started + n) * 1000;
  writeLines(path.join(dir, "plan-0.jsonl"), [ev("text", s(5), { text: "p" }), ev("text", s(40), { text: "p2" })]);
  writeLines(path.join(dir, "build-0.jsonl"), [tool(s(60), "read", { filePath: "a" }), ev("step_finish", s(100), { tokens: { input: 1, output: 1 } })]);
  writeLines(path.join(dir, "complete1-0.jsonl"), [ev("text", s(120), { text: "c" })]);
  writeLines(path.join(dir, "review-0.jsonl"), [ev("text", s(200), { text: "r" })]);
  const stats = path.join(root, "stats.jsonl");
  const line = (o) => JSON.stringify({ issue: 24, slot: 1, ...o });
  writeLines(stats, [
    line({ ts: started - 5000, kind: "outcome", outcome: "blocked" }),              // an older run of the same issue
    line({ ts: started + 150, kind: "stage", stage: "verify", secs: 20, result: "ok" }), // verify began at +130
    line({ ts: started + 260, kind: "stage", stage: "ci", secs: 40, result: "ok" }),    // ci began at +220
    JSON.stringify({ ts: started + 230, issue: 25, slot: 1, kind: "stage", stage: "merge", secs: 1, result: "ok" }), // other issue
    JSON.stringify({ ts: started + 230, issue: 24, slot: 2, kind: "stage", stage: "merge", secs: 1, result: "ok" }), // other slot
    line({ ts: started + 300, kind: "outcome", outcome: "merged", url: "https://github.com/x/y/pull/9" }),
    line({ ts: started + 99999, kind: "outcome", outcome: "ci_failed" }),            // far outside the window
  ]);
  fs.appendFileSync(stats, '{"ts": 1, "issue"'); // partial last line
  const r = getRun(root, stats, name);
  assert.equal(r.id, name);
  assert.equal(r.issue, 24);
  assert.equal(r.outcome, "merged");
  assert.equal(r.url, "https://github.com/x/y/pull/9");
  assert.deepEqual(r.timeline.map((x) => x.stage), ["plan", "build", "verify", "review", "ci", "live"]);
  assert.deepEqual(r.timeline.map((x) => x.t), [s(5), s(60), s(130), s(200), s(220), s(300)]);
  assert.deepEqual(r.items.map((i) => i.phase), ["plan", "plan", "build", "build", "complete1", "review"]);
  assert.ok(r.items.every((i, k, a) => k === 0 || a[k - 1].t <= i.t));
  assert.equal(r.started, started);
  assert.equal(r.ended, started + 200);
  const list = listRuns(root, stats).runs[0];
  assert.equal(list.outcome, "merged");
  assert.deepEqual(list.turns, ["plan", "build", "complete1", "review"]);
  assert.equal(list.items, 6);
});

test("replay: no outcome yet -> null; legacy id without slot suffix; unknown run -> null", () => {
  const root = tmp();
  const started = 1792130000;
  const d = new Date(started * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = `issue-7-${d}`;
  const dir = mkRun(root, name);
  writeLines(path.join(dir, "plan-0.jsonl"), [ev("text", (started + 1) * 1000, { text: "x" })]);
  const stats = path.join(root, "stats.jsonl");
  const r = getRun(root, stats, name);
  assert.equal(r.outcome, null);
  assert.equal(r.url, null);
  assert.equal(r.slot, 1);
  assert.deepEqual(r.timeline.map((x) => x.stage), ["plan"]);
  writeLines(stats, [JSON.stringify({ ts: started + 50, issue: 7, kind: "outcome", outcome: "pr", url: "u", slot: 3 })]);
  assert.equal(getRun(root, stats, name).outcome, "pr", "slot-less id accepts any slot");
  assert.equal(getRun(root, stats, "issue-8-20261016T000000Z-s1"), null);
});

test("replay: items are capped at 5000 newest", () => {
  const root = tmp();
  const started = 1792130000;
  const { name, dir } = runAt(root, 5, started);
  const lines = [];
  for (let i = 0; i < MAX_REPLAY_ITEMS + 20; i++) lines.push(ev("text", (started + 1) * 1000 + i, { text: `m${i}` }));
  writeLines(path.join(dir, "build-0.jsonl"), lines);
  const r = getRun(root, path.join(root, "s.jsonl"), name);
  assert.equal(r.items.length, MAX_REPLAY_ITEMS);
  assert.equal(r.items[0].text, "m20");
  void T0;
});
