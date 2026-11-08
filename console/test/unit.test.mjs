import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashPassword, verifyPassword, parseHash, signCookie, verifyCookie, LoginLimiter, checkCredentials, parseCookies,
} from "../lib/auth.mjs";
import {
  validatePatch, applyIssueAction, sanitizeMessage, normalizeControl, ControlStore, DEFAULT_CONTROL, MAX_QUEUE, MAX_SKIP,
  MODEL_RE,
} from "../lib/control.mjs";
import { parseEvent, parseLines, safeEventsPath, ActivityTail, FIRST_TAIL_BYTES } from "../lib/activity.mjs";
import { StatsReader, computeMetrics, dayStart } from "../lib/metrics.mjs";
import { JsonCache, readJsonSafe, writeJsonAtomic } from "../lib/files.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, "../../contracts/fixtures");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hc-test-"));

// ------------------------------------------------------------------ auth
test("auth: hash and verify", async () => {
  const h = await hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("correct horse batterz", h), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
  assert.equal(parseHash("scrypt$1$8$1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA"), null); // N too small
  assert.equal(parseHash("scrypt$99999999$8$1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA"), null); // N too big
});

test("auth: wrong email or wrong password both fail; email is case-insensitive", async () => {
  const auth = { email: "Owner@Example.com", hash: await hashPassword("a long enough password") };
  assert.equal(await checkCredentials(auth, "owner@example.com", "a long enough password"), true);
  assert.equal(await checkCredentials(auth, "  OWNER@example.com ", "a long enough password"), true);
  assert.equal(await checkCredentials(auth, "other@example.com", "a long enough password"), false);
  assert.equal(await checkCredentials(auth, "owner@example.com", "nope nope nope"), false);
  assert.equal(await checkCredentials(null, "owner@example.com", "a long enough password"), false);
});

test("auth: cookie sign, verify, expiry, tamper", () => {
  const secret = Buffer.alloc(32, 9);
  const now = 1_800_000_000;
  const c = signCookie(secret, now);
  assert.equal(c.exp, now + 604800);
  const ok = verifyCookie(secret, c.value, now + 10);
  assert.deepEqual(ok, { exp: c.exp, nonce: c.nonce });
  assert.equal(verifyCookie(secret, c.value, c.exp), null, "expired at exp");
  assert.equal(verifyCookie(secret, c.value, c.exp + 1), null);
  assert.equal(verifyCookie(Buffer.alloc(32, 8), c.value, now), null, "other secret");
  const [exp, nonce, mac] = c.value.split(".");
  assert.equal(verifyCookie(secret, `${Number(exp) + 99999}.${nonce}.${mac}`, now), null, "exp tampered");
  assert.equal(verifyCookie(secret, `${exp}.${nonce}x.${mac}`, now), null, "nonce tampered");
  const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
  assert.equal(verifyCookie(secret, `${exp}.${nonce}.${flipped}`, now), null, "mac tampered");
  assert.equal(verifyCookie(secret, "", now), null);
  assert.equal(verifyCookie(secret, "a.b.c", now), null);
  assert.deepEqual(parseCookies("a=1; __Host-hc=xyz; b=2"), { a: "1", "__Host-hc": "xyz", b: "2" });
});

test("auth: global limiter, 5 failures lock for 15 minutes", () => {
  const l = new LoginLimiter();
  let t = 1_000_000;
  for (let i = 0; i < 4; i++) { assert.equal(l.retryAfter(t), 0); l.fail(t); t += 1000; }
  assert.equal(l.retryAfter(t), 0, "4 failures: still open");
  l.fail(t);
  assert.equal(l.retryAfter(t + 1000), 15 * 60 - 1, "6th attempt is locked");
  assert.equal(l.retryAfter(t + 14 * 60e3), 60);
  assert.equal(l.retryAfter(t + 15 * 60e3), 0, "unlocks after 15 minutes");
  // failures spread beyond the window never lock
  const l2 = new LoginLimiter();
  for (let i = 0; i < 20; i++) { l2.fail(i * 4 * 60e3); assert.equal(l2.retryAfter(i * 4 * 60e3 + 1), 0); }
});

// ------------------------------------------------------------------ control
const FREE = new Set(["opencode/deepseek-v4.1-flash-free", "opencode/space-bunny-free"]);
const ctx = { freeIds: FREE, haltId: "h-1" };

const good2 = (patch) => assert.equal(validatePatch(patch, { freeIds: new Set([...FREE, "opencode-go/deepseek-v4.1-flash"]), haltId: null }).ok, true, JSON.stringify(patch));

test("control: field bounds", () => {
  const bad = (patch, field) => assert.deepEqual(validatePatch(patch, ctx), { ok: false, field }, JSON.stringify(patch));
  const good = (patch) => assert.equal(validatePatch(patch, ctx).ok, true, JSON.stringify(patch));
  good({ agents: 0 }); good({ agents: 3 });
  bad({ agents: 4 }, "agents"); bad({ agents: -1 }, "agents"); bad({ agents: 1.5 }, "agents"); bad({ agents: "2" }, "agents");
  good({ models: ["opencode/space-bunny-free"] });
  good({ models: ["opencode/space-bunny-free", "opencode/deepseek-v4.1-flash-free"] });
  bad({ models: [] }, "models"); bad({ models: "x" }, "models");
  bad({ models: ["opencode/deepseek-v4.1-flash"] }, "models"); // the paid sibling under the wrong provider
  bad({ models: ["opencode-go/deepseek-v4.1-flash"] }, "models"); // Go id not in the allowed set
  good2({ models: ["opencode-go/deepseek-v4.1-flash", "opencode/space-bunny-free"] });
  bad({ models: ["deepseek-v4.1-flash-free"] }, "models");
  bad({ models: ["opencode/space-bunny-free", "opencode/space-bunny-free"] }, "models");
  bad({ models: Array(6).fill(0).map((_, i) => `opencode/m${i}`) }, "models");
  assert.deepEqual(validatePatch({ models: ["opencode/space-bunny-free"] }, { freeIds: null }), { ok: false, field: "models" });
  good({ model_mode: "auto" }); good({ model_mode: "ordered" }); bad({ model_mode: "random" }, "model_mode");
  good({ paused: true }); bad({ paused: "yes" }, "paused"); bad({ paused: 1 }, "paused");
  good({ resume_ack: "h-1" }); good({ resume_ack: null });
  bad({ resume_ack: "h-2" }, "resume_ack");
  assert.deepEqual(validatePatch({ resume_ack: "h-1" }, { freeIds: FREE, haltId: null }), { ok: false, field: "resume_ack" });
  bad({ queue: [] }, "queue"); // not patchable here, only through /api/issues
  bad({ skip: [1] }, "skip");
  bad({}, "body"); bad([], "body"); bad(null, "body");
});

test("control: model ids follow the shared grammar (contracts/fixtures/model-ids.json)", () => {
  const ids = JSON.parse(fs.readFileSync(path.join(FIX, "model-ids.json"), "utf8"));
  for (const id of ids.valid) assert.equal(MODEL_RE.test(id), true, `valid: ${id}`);
  for (const id of ids.invalid) assert.equal(MODEL_RE.test(id), false, `invalid: ${id}`);
});

test("control: a Go account-2 id survives read, queue and write (31 Oct 2026 regression)", () => {
  const both = ["opencode-go/deepseek-v4.1-flash", "opencode-go@2/deepseek-v4.1-flash"];
  assert.deepEqual(normalizeControl({ models: both }).models, both);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "control.json"), JSON.stringify({ v: 1, agents: 3, models: both, queue: [] }));
  const store = new ControlStore(dir);
  store.write(applyIssueAction(store.read(), "queue", 167).control); // a queue action rewrites control.json
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "control.json"), "utf8")).models, both);
  assert.equal(validatePatch({ models: both }, { freeIds: new Set(both), haltId: null }).ok, true, "console can set it");
  assert.deepEqual(validatePatch({ models: ["opencode-go@2/deepseek-v4.1-flash"] }, { freeIds: new Set([both[0]]), haltId: null }),
    { ok: false, field: "models" }, "still only ids models.json lists");
});

test("control: queue and skip limits and semantics", () => {
  let c = normalizeControl(DEFAULT_CONTROL);
  for (let n = 1; n <= MAX_QUEUE; n++) c = applyIssueAction(c, "queue", n).control;
  assert.equal(c.queue.length, MAX_QUEUE);
  assert.deepEqual(applyIssueAction(c, "queue", 999), { ok: false, field: "queue" });
  assert.equal(applyIssueAction(c, "queue", 3).ok, true, "re-queueing an existing entry is not growth");
  assert.equal(applyIssueAction(c, "queue", 3).control.queue.at(-1).n, 3);
  for (let n = 1; n <= MAX_SKIP; n++) c = applyIssueAction(c, "skip", 1000 + n).control;
  assert.equal(c.skip.length, MAX_SKIP);
  assert.deepEqual(applyIssueAction(c, "skip", 5000), { ok: false, field: "skip" });
  assert.equal(applyIssueAction(c, "skip", 1001).ok, true, "skipping twice is a no-op");
  const sk = applyIssueAction(c, "skip", 7).ok; assert.equal(sk, false);
  const d = applyIssueAction(applyIssueAction(normalizeControl(null), "queue", 7).control, "skip", 7).control;
  assert.deepEqual(d.queue, [], "skip removes the queue entry");
  assert.deepEqual(d.skip, [7]);
  assert.deepEqual(applyIssueAction(d, "unskip", 7).control.skip, []);
  assert.deepEqual(applyIssueAction(applyIssueAction(normalizeControl(null), "queue", 7).control, "unqueue", 7).control.queue, []);
  assert.equal(applyIssueAction(c, "explode", 1).ok, false);
  const q = applyIssueAction(normalizeControl(null), "queue", 37, { consumed: { 37: "2999-01-01T00:00:00Z" } }).control.queue[0];
  assert.equal(q.at, "2999-01-01T00:00:01Z", "queue time must be later than consumed");
});

test("control: message sanitising", () => {
  assert.equal(sanitizeMessage("a\u0000b\u0007c\r\nd\te"), "abc\nde");
  assert.equal(sanitizeMessage("x".repeat(5000)).length, 2000);
  assert.equal(sanitizeMessage("   "), "");
  assert.equal(sanitizeMessage(42), null);
});

test("control: normalize is lenient, store writes 0660 JSON atomically", async () => {
  assert.deepEqual(normalizeControl({ agents: 9, models: ["x"], queue: "no", skip: [1, "a", 1] }).skip, [1]);
  assert.equal(normalizeControl({ agents: 9 }).agents, 1);
  const dir = tmp();
  const store = new ControlStore(dir);
  assert.deepEqual(store.read().agents, 1);
  const order = [];
  await Promise.all([1, 2, 3].map((n) => store.lock(async () => {
    order.push(`s${n}`); await new Promise((r) => setTimeout(r, 10)); order.push(`e${n}`);
    store.write({ ...store.read(), agents: n });
  })));
  assert.deepEqual(order, ["s1", "e1", "s2", "e2", "s3", "e3"], "mutex serialises");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "control.json"), "utf8")).agents, 3);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "control.json")).mode & 0o777, 0o660);
  assert.deepEqual(fs.readdirSync(dir), ["control.json"], "no tmp files left");
});

// ------------------------------------------------------------------ activity
test("activity: parses the real plan-0.jsonl fixture", () => {
  const text = fs.readFileSync(path.join(FIX, "log", "plan-0.jsonl"), "utf8");
  const items = parseLines(text);
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  const count = (type) => lines.filter((l) => l.type === type).length;
  assert.equal(items.filter((i) => i.kind === "tool").length, count("tool_use"));
  assert.equal(items.filter((i) => i.kind === "text").length, lines.filter((l) => l.type === "text" && l.part.text.trim()).length);
  assert.equal(items.filter((i) => i.kind === "step").length, count("step_finish"));
  assert.equal(items.length, items.filter((i) => ["tool", "text", "step", "error"].includes(i.kind)).length);
  const first = items.find((i) => i.kind === "tool" && i.tool === "read");
  assert.equal(first.target, "crates/shop-core/src/lib.rs", "work prefix stripped");
  assert.equal(first.status, "completed");
  const bash = items.find((i) => i.tool === "bash");
  assert.match(bash.target, /^git log --oneline -10/);
  assert.ok(!bash.target.includes("\n") && bash.target.length <= 120);
  const text0 = items.find((i) => i.kind === "text");
  assert.equal(text0.text, "I'll read the coupon module and the cart route before planning.");
  const step = items.find((i) => i.kind === "step");
  assert.deepEqual(step.tokens, { in: 2382, out: 134 });
  assert.ok(items.every((i) => Number.isFinite(i.t)));
  for (const i of items) assert.deepEqual(Object.keys(i), ["t", "kind", "tool", "target", "text", "status", "tokens"]);
});

test("activity: per-tool targets and error events", () => {
  const tu = (tool, input, title) => parseEvent({ type: "tool_use", timestamp: 5, part: { tool, state: { status: "completed", input, title } } });
  assert.equal(tu("edit", { filePath: "/home/factory/s2/work/a/b.rs" }).target, "a/b.rs");
  assert.equal(tu("write", { filePath: "/home/factory/work/x.rs" }).target, "x.rs");
  assert.equal(tu("grep", { pattern: "foo.*bar" }).target, "foo.*bar");
  assert.equal(tu("glob", { pattern: "**/*.rs" }).target, "**/*.rs");
  assert.equal(tu("task", { description: "explore" }).target, "explore");
  assert.equal(tu("webfetch", { url: "https://x.y/z" }).target, "https://x.y/z");
  assert.equal(tu("todowrite", {}, "5 todos").target, "5 todos");
  assert.equal(tu("bash", { command: "a".repeat(300) }).target.length, 120);
  assert.equal(parseEvent({ type: "error", timestamp: 1, error: { name: "E", data: { message: "boom\nline2" } } }).text, "boom line2");
  assert.equal(parseEvent({ type: "text", timestamp: 1, part: { text: "x".repeat(500) } }).text.length, 200);
  assert.equal(parseEvent({ type: "step_start", timestamp: 1, part: {} }), null);
});

test("activity: path traversal and escapes are rejected", () => {
  const log = tmp();
  const ok = path.join(log, "issue-1-x-s1", "plan-0.jsonl");
  assert.equal(safeEventsPath(log, ok), path.resolve(ok));
  assert.equal(safeEventsPath(log, path.join(log, "..", "etc", "passwd")), null);
  assert.equal(safeEventsPath(log, log + "/issue-1/../../outside.jsonl"), null);
  assert.equal(safeEventsPath(log, log + "/a/../a/b.jsonl"), null, "any .. is refused, even harmless");
  assert.equal(safeEventsPath(log, path.resolve(log, "..", "other", "x.jsonl")), null);
  assert.equal(safeEventsPath(log, log), null);
  assert.equal(safeEventsPath(log, "relative/x.jsonl"), null);
  assert.equal(safeEventsPath(log, null), null);
  assert.equal(safeEventsPath(log, ok + "\0.jsonl"), null);
  const t = new ActivityTail(log, 1);
  assert.equal(t.poll(path.join(log, "..", "x.jsonl")), null);
});

test("activity: tail reads only the last 256 KB on attach, then follows by offset", () => {
  const log = tmp();
  const dir = path.join(log, "issue-1-x-s1"); fs.mkdirSync(dir);
  const file = path.join(dir, "build-0.jsonl");
  const line = (i) => JSON.stringify({ type: "text", timestamp: i, part: { text: `msg ${i} ${"x".repeat(80)}` } }) + "\n";
  let body = "";
  for (let i = 0; i < 8000; i++) body += line(i);
  assert.ok(body.length > 3 * FIRST_TAIL_BYTES);
  fs.writeFileSync(file, body);
  const t = new ActivityTail(log, 2);
  const r = t.poll(file);
  assert.equal(r.reset, true);
  assert.equal(r.slot, 2);
  assert.equal(r.items.length, 50, "last 50 only");
  assert.equal(r.items.at(-1).t, 7999);
  assert.equal(t.poll(file), null, "nothing new");
  assert.ok(t.offset === Buffer.byteLength(body));
  // the 256 KB window really bounds the read: first item of a bigger window would be < 4000-1600
  fs.appendFileSync(file, line(8000) + line(8001).slice(0, 30)); // second line is partial
  const r2 = t.poll(file);
  assert.equal(r2.reset, false);
  assert.deepEqual(r2.items.map((i) => i.t), [8000]);
  fs.appendFileSync(file, line(8001).slice(30));
  assert.deepEqual(t.poll(file).items.map((i) => i.t), [8001], "partial line completed later");
  // new turn file -> reset
  const file2 = path.join(dir, "verify-0.jsonl");
  fs.writeFileSync(file2, line(7));
  const r3 = t.poll(file2);
  assert.equal(r3.reset, true);
  assert.deepEqual(r3.items.map((i) => i.t), [7]);
  // attach to a file with a missing path yields a reset with nothing
  assert.deepEqual(t.poll(path.join(dir, "later-0.jsonl")), { slot: 2, items: [], reset: true });
  // null path keeps what is shown
  assert.equal(t.poll(null), null);
  assert.equal(t.items.length, 0);
});

test("activity: a 256 KB window cuts at a line boundary", () => {
  const log = tmp();
  const file = path.join(log, "e.jsonl");
  const line = (i) => JSON.stringify({ type: "text", timestamp: i, part: { text: "y".repeat(1000) } }) + "\n";
  let body = ""; for (let i = 0; i < 1000; i++) body += line(i); // ~1 MB
  fs.writeFileSync(file, body);
  const t = new ActivityTail(log, 1);
  const r = t.poll(file);
  assert.equal(r.items.length, 50);
  assert.equal(r.items.at(-1).t, 999);
  assert.ok(r.items.every((i) => i.kind === "text"), "no half-parsed line");
});

// ------------------------------------------------------------------ metrics
function loadStats(file = path.join(FIX, "ui", "stats.jsonl")) {
  const r = new StatsReader(file);
  assert.equal(r.refresh(), true);
  return r;
}

test("metrics: fixture numbers per section 5.3", () => {
  const stats = loadStats();
  const github = JSON.parse(fs.readFileSync(path.join(FIX, "ui", "github.json"), "utf8"));
  const rows = fs.readFileSync(path.join(FIX, "ui", "stats.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const now = Math.max(...rows.map((r) => r.ts)) + 600;
  const m = computeMetrics(stats, github, now, { tz: "Asia/Jakarta" });

  const merged = rows.filter((r) => r.kind === "outcome" && r.outcome === "merged");
  assert.equal(m.merged_total, merged.length);
  assert.equal(m.merged_24h, merged.filter((r) => r.ts >= now - 86400).length);
  assert.equal(m.merged_7d, merged.filter((r) => r.ts >= now - 7 * 86400).length);
  const remaining = github.issues.filter((i) => ["queued", "eligible", "running", "blocked"].includes(i.class)).length;
  assert.equal(m.remaining, remaining);
  assert.ok(remaining > 0);
  const m48 = merged.filter((r) => r.ts >= now - 172800).length;
  assert.equal(m.throughput_per_h, Math.round((m48 / 48) * 1000) / 1000);
  assert.equal(m.eta_h, null, "fewer than 3 merges in 48h");

  for (const [model, s] of Object.entries(m.success)) {
    const att = rows.filter((r) => r.kind === "outcome" && r.model === model && ["pr", "merged", "no_commit", "verify_failed", "ci_failed"].includes(r.outcome));
    assert.equal(s.attempts, att.length);
    assert.equal(s.merged, att.filter((r) => r.outcome === "merged").length);
    assert.equal(s.rate, Math.round((s.merged / s.attempts) * 1000) / 1000);
  }
  assert.ok(Object.keys(m.success).length >= 1);

  const stageRows = rows.filter((r) => r.kind === "stage" && r.result === "ok");
  for (const [stage, med] of Object.entries(m.stage_median_min)) {
    const xs = stageRows.filter((r) => r.stage === stage).map((r) => r.secs).sort((a, b) => a - b);
    const mid = xs.length >> 1;
    const expect = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    assert.equal(med, Math.round((expect / 60) * 10) / 10, stage);
  }
  const top = Object.entries(m.stage_median_min).sort((a, b) => b[1] - a[1])[0];
  assert.equal(m.bottleneck, top ? top[0] : null);

  const today = dayStart(now, "Asia/Jakarta");
  const calls = rows.filter((r) => r.kind === "call" && r.ts >= today);
  assert.deepEqual(m.tokens_today, {
    input: calls.reduce((a, r) => a + r.tokens.input, 0),
    output: calls.reduce((a, r) => a + r.tokens.output, 0),
    cache_read: calls.reduce((a, r) => a + r.tokens.cache_read, 0),
  });
  assert.equal(m.rate_limited_1h, rows.filter((r) => r.kind === "call" && r.rate_limited && r.ts >= now - 3600).length);
  const all = rows.filter((r) => r.kind === "call");
  assert.deepEqual(m.tokens_total, {
    input: all.reduce((a, r) => a + r.tokens.input, 0),
    output: all.reduce((a, r) => a + r.tokens.output, 0),
    reasoning: all.reduce((a, r) => a + (r.tokens.reasoning ?? 0), 0),
    cache_read: all.reduce((a, r) => a + r.tokens.cache_read, 0),
    since: Math.min(...all.map((r) => r.ts)),
  });
  assert.ok(m.tokens_total.input >= m.tokens_today.input, "every call, not only today's");
});

test("metrics: tokens_total counts every call ever read and restarts only with a new file", () => {
  const dir = tmp(); const f = path.join(dir, "stats.jsonl");
  const call = (ts, i, o, r, c) => JSON.stringify({ kind: "call", ts, slot: 1, tokens: { input: i, output: o, reasoning: r, cache_read: c } }) + "\n";
  fs.writeFileSync(f, call(1_791_000_000, 100, 10, 5, 1000) + call(1_792_000_000, 200, 20, 0, 2000));
  const r = new StatsReader(f); r.refresh();
  fs.appendFileSync(f, call(1_792_100_000, 1, 2, 3, 4) + JSON.stringify({ kind: "call", ts: 1_792_100_001, slot: 2 }) + "\n");
  r.refresh();
  const m = computeMetrics(r, { issues: [] }, 1_792_100_100);
  assert.deepEqual(m.tokens_total, { input: 301, output: 32, reasoning: 8, cache_read: 3004, since: 1_791_000_000 });
  fs.rmSync(f); fs.writeFileSync(f, call(1_792_200_000, 7, 7, 7, 7)); // replaced, not appended
  r.refresh();
  assert.deepEqual(computeMetrics(r, { issues: [] }, 1_792_200_100).tokens_total, { input: 7, output: 7, reasoning: 7, cache_read: 7, since: 1_792_200_000 });
});

test("metrics: eta needs 3 merges in 7 days and busy time", () => {
  const dir = tmp(); const f = path.join(dir, "stats.jsonl");
  const now = 1_792_200_000;
  const mk = (i, outcome = "merged") => JSON.stringify({ ts: now - 3600 * i, issue: i, slot: 1, kind: "outcome", outcome, model: "opencode/a-free" });
  const st = (i) => JSON.stringify({ ts: now - 3600 * i - 10, issue: i, slot: 1, kind: "stage", stage: "build", secs: 1800, result: "ok" });
  const gh = { issues: Array(10).fill(0).map((_, k) => ({ n: 100 + k, class: "eligible", deps: [] })).concat([{ n: 200, class: "failed", deps: [] }]) };
  fs.writeFileSync(f, [st(1), mk(1), st(2), mk(2), st(3), mk(3, "no_commit"), mk(200)].join("\n") + "\n");
  let m = computeMetrics(loadStats(f), gh, now);
  assert.equal(m.merged_24h, 2); assert.equal(m.merged_7d, 2);
  assert.equal(m.eta_h, null); assert.equal(m.eta, null);
  assert.deepEqual(m.success["opencode/a-free"], { attempts: 4, merged: 3, rate: 0.75 });
  fs.appendFileSync(f, [st(4), mk(4)].join("\n") + "\n");
  m = computeMetrics(loadStats(f), gh, now);
  assert.equal(m.throughput_per_h, Math.round((3 / 48) * 1000) / 1000);
  // 3 merges in 7 days over 2 busy lane-hours: 1.5 per lane-hour; 10 issues of 2/3 h on 3 lanes = 4 rounds
  assert.equal(m.eta.doable, 10);
  assert.equal(m.eta_h, 2.7);
});

test("metrics: dayStart is local midnight in the given zone", () => {
  const at = (iso) => Date.parse(iso) / 1000;
  // 2026-10-16 17:00:00Z is 2026-10-17 00:00 in Jakarta (UTC+7, no DST)
  const midnight = at("2026-10-16T17:00:00Z");
  assert.equal(dayStart(midnight, "Asia/Jakarta"), midnight);
  assert.equal(dayStart(midnight - 1, "Asia/Jakarta"), midnight - 86400);
  assert.equal(dayStart(midnight + 86399, "Asia/Jakarta"), midnight);
  // UTC
  assert.equal(dayStart(at("2026-10-16T23:59:59Z"), "UTC"), at("2026-10-16T00:00:00Z"));
  assert.equal(dayStart(at("2026-10-17T00:00:00Z"), "UTC"), at("2026-10-17T00:00:00Z"));
  // New York across the 2026-03-08 spring-forward (02:00 EST -> 03:00 EDT): that day is 23 h long
  assert.equal(dayStart(at("2026-03-08T04:59:59Z"), "America/New_York"), at("2026-03-07T05:00:00Z")); // 23:59:59 EST on the 7th
  assert.equal(dayStart(at("2026-03-08T05:00:00Z"), "America/New_York"), at("2026-03-08T05:00:00Z")); // midnight EST
  assert.equal(dayStart(at("2026-03-08T20:00:00Z"), "America/New_York"), at("2026-03-08T05:00:00Z")); // 16:00 EDT, after the jump
  assert.equal(dayStart(at("2026-03-09T12:00:00Z"), "America/New_York"), at("2026-03-09T04:00:00Z")); // next midnight is EDT
  // and across the 2026-11-01 fall-back (02:00 EDT -> 01:00 EST): a 25 h day
  assert.equal(dayStart(at("2026-11-02T04:59:59Z"), "America/New_York"), at("2026-11-01T04:00:00Z")); // 23:59:59 EST
  // a zone whose midnight a DST jump skips: Santiago springs from 00:00 to 01:00 on 2026-09-06
  assert.equal(dayStart(at("2026-09-06T15:00:00Z"), "America/Santiago"), at("2026-09-06T04:00:00Z"));
});

test("metrics: reader is incremental and skips a partial last line", () => {
  const dir = tmp(); const f = path.join(dir, "stats.jsonl");
  const o = (n) => JSON.stringify({ ts: 100 + n, issue: n, kind: "outcome", outcome: "merged", model: "opencode/m" });
  fs.writeFileSync(f, o(1) + "\n" + o(2).slice(0, 20));
  const r = new StatsReader(f);
  assert.equal(r.refresh(), true);
  assert.equal(r.outcomes.length, 1);
  assert.equal(r.outcomes[0].slot, 1, "lines without slot are slot 1");
  assert.equal(r.refresh(), false);
  fs.appendFileSync(f, o(2).slice(20) + "\nnot json\n" + o(3) + "\n");
  assert.equal(r.refresh(), true);
  assert.deepEqual(r.outcomes.map((x) => x.issue), [1, 2, 3]);
  assert.deepEqual(r.recent().map((x) => x.issue), [3, 2, 1], "newest first");
  fs.writeFileSync(f, o(9) + "\n"); // truncated / rotated
  assert.equal(r.refresh(), true);
  assert.deepEqual(r.outcomes.map((x) => x.issue), [9]);
});

// ------------------------------------------------------------------ files
test("files: symlinks and non-regular files are refused", (t) => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "real.json"), '{"a":1}');
  try { fs.symlinkSync(path.join(dir, "real.json"), path.join(dir, "link.json")); } catch { t.skip("cannot create symlinks here"); return; }
  assert.deepEqual(readJsonSafe(path.join(dir, "real.json")), { ok: true, value: { a: 1 } });
  assert.deepEqual(readJsonSafe(path.join(dir, "link.json")), { ok: false, reason: "symlink" });
  fs.mkdirSync(path.join(dir, "d.json"));
  assert.equal(readJsonSafe(path.join(dir, "d.json")).reason, "not_regular");
  const c = new JsonCache(path.join(dir, "link.json"));
  assert.equal(c.refresh(), false);
  assert.equal(c.value, null);
  assert.equal(c.error, "symlink");
});

test("files: oversize refused; last good value kept on garbage; absence resets", () => {
  const dir = tmp(); const f = path.join(dir, "x.json");
  fs.writeFileSync(f, JSON.stringify({ big: "x".repeat(2000) }));
  assert.equal(readJsonSafe(f, 1000).reason, "too_big");
  const c = new JsonCache(f, { validate: (v) => v && typeof v === "object" && !Array.isArray(v) });
  assert.equal(c.refresh(), true);
  assert.equal(c.value.big.length, 2000);
  assert.equal(c.refresh(), false, "unchanged");
  fs.writeFileSync(f, "{ this is not json");
  assert.equal(c.refresh(), false);
  assert.equal(c.value.big.length, 2000, "last good kept");
  assert.equal(c.error, "parse");
  fs.writeFileSync(f, "[1,2,3] ");
  assert.equal(c.refresh(), false);
  assert.equal(c.error, "invalid");
  writeJsonAtomic(f, { ok: true });
  assert.equal(c.refresh(), true);
  assert.deepEqual(c.value, { ok: true });
  fs.unlinkSync(f);
  assert.equal(c.refresh(), true);
  assert.equal(c.value, null);
});
