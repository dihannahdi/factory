import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StatsReader, computeMetrics } from "../lib/metrics.mjs";
import {
  scopeIssues, simulate, effectiveLanes, computeEta, computeWaste, effortByIssue, quantile, rateDispersion, Z80,
} from "../lib/eta.mjs";
import { calibrate, featuresOf, looMae, SizeCalibrator, MIN_N } from "../lib/sizecal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ETA = path.resolve(HERE, "../../contracts/fixtures/eta");
const github = JSON.parse(fs.readFileSync(path.join(ETA, "github.json"), "utf8"));
const reader = new StatsReader(path.join(ETA, "stats.jsonl"));
reader.refresh();
const NOW = Math.max(...reader.stages.map((s) => s.ts), ...reader.outcomes.map((o) => o.ts));
const DAY = 86400, H = 3600;

// A hand-built reader: records are appended in order, seq is file order.
function mk(rows) {
  const r = { outcomes: [], stages: [], calls: [] };
  rows.forEach((x, seq) => {
    if (x.kind === "outcome") r.outcomes.push({ seq, slot: 1, model: null, url: null, ...x });
    else r.stages.push({ seq, slot: 1, result: "ok", ...x });
  });
  return r;
}
const stage = (ts, issue, secs, extra = {}) => ({ kind: "stage", stage: "build", ts, issue, secs, ...extra });
const out = (ts, issue, outcome, extra = {}) => ({ kind: "outcome", ts, issue, outcome, ...extra });
const iss = (n, cls, deps = [], extra = {}) => ({ n, class: cls, deps, tag: `T-${n}`, ...extra });

test("eta fixtures: scope, merges per issue, rate, P50 and P80", () => {
  const m = computeMetrics(reader, github, NOW, { control: { agents: 3 }, slots: [] });
  const e = m.eta;
  assert.equal(e.doable, 54);
  assert.deepEqual(e.waiting_human.map((w) => w.n), [53, 54, 98, 101]);
  assert.ok(e.waiting_human.every((w) => typeof w.tag === "string"));
  assert.equal(e.merges_per_issue, Math.round((17 / 16) * 1000) / 1000);
  const busy = reader.stages.filter((s) => s.ts >= NOW - 7 * DAY && s.stage !== "pick").reduce((a, s) => a + s.secs, 0) / H;
  assert.ok(Math.abs(busy - 84.4) < 0.1, `busy ${busy}`);
  const merged7 = reader.outcomes.filter((o) => o.outcome === "merged" && o.ts >= NOW - 7 * DAY).length;
  assert.equal(e.rate_per_lane_h, Math.round((merged7 / busy) * 1000) / 1000);
  assert.ok(Math.abs(e.rate_per_lane_h - 0.201) < 0.001);
  assert.equal(e.lanes, 3);
  assert.ok(Math.abs(e.p50_h - 95) < 1.5, `p50 ${e.p50_h}`);
  // q_effort is the effort-based p80/p50; q_rate the rate's own uncertainty; P80 is the same
  // simulation with every cost x the larger of the two
  const eff = [...effortByIssue(reader).values()];
  assert.ok(eff.length >= 5);
  const q = quantile(eff, 0.8) / quantile(eff, 0.5);
  assert.ok(q >= 1);
  assert.equal(e.q_effort, Math.round(q * 1000) / 1000);
  const { phi, days } = rateDispersion(reader, NOW, merged7 / busy);
  assert.deepEqual([phi, days], [1, 2], "the fixture spans 2 days: phi 1 is used");
  assert.equal(e.dispersion, null, "...and not shown as measured");
  const qr = Math.exp(Z80 * Math.sqrt(phi * (1 / merged7 + 1 / (54 * 17 / 16))));
  assert.equal(e.q_rate, Math.round(qr * 1000) / 1000);
  const flat = (17 / 16) / (merged7 / busy);
  const sc = scopeIssues(github.issues);
  const cost = (k) => new Map(sc.doable.map((n) => [n, flat * k]));
  assert.equal(e.p80_h, Math.round(simulate(sc.doable, sc.deps, cost(Math.max(q, qr)), 3) * 10) / 10);
  assert.ok(e.p80_h >= e.p50_h);
  assert.equal(m.eta_h, e.p50_h);
  assert.deepEqual(e.size_model, { active: false, feature: null, n: 0, flat_mae: null, mae: null });
});

test("eta: fewer lanes, longer ETA; lanes = min(control, effective_agents, 3), at least 1", () => {
  assert.equal(effectiveLanes({ agents: 3 }, []), 3);
  assert.equal(effectiveLanes({ agents: 9 }, []), 3);
  assert.equal(effectiveLanes({ agents: 2 }, [{ effective_agents: 0 }, { effective_agents: 1 }]), 1);
  assert.equal(effectiveLanes({ agents: 0 }, []), 1);
  assert.equal(effectiveLanes(undefined, undefined), 3);
  const one = computeMetrics(reader, github, NOW, { control: { agents: 1 }, slots: [] }).eta;
  assert.equal(one.lanes, 1);
  assert.ok(one.p50_h > 150 && one.p50_h < 400);
});

test("scope: closure is transitive, ignores deps absent from github.json, survives cycles", () => {
  const s = scopeIssues([
    iss(1, "failed"), iss(2, "blocked", [1]), iss(3, "blocked", [2]), iss(4, "eligible", [99]),
    iss(5, "taken"), iss(6, "queued", [4]), iss(7, "eligible", [8]), iss(8, "eligible", [7]), iss(9, "merged-ish"),
    iss(10, "running", [3, 6]), iss(11, "skipped"), iss(12, "eligible", [11]),
  ]);
  // 7 <-> 8 is a cycle: neither can ever start, so both wait for a human
  assert.deepEqual(s.doable, [4, 6]);
  assert.deepEqual(s.waiting_human.map((w) => w.n), [2, 3, 7, 8, 10, 12]);
});

test("scope: a cycle and everything under it wait for a human (#23 <-> #58)", () => {
  const s = scopeIssues([
    iss(23, "blocked", [58]), iss(58, "blocked", [23, 29]), iss(29, "eligible"), iss(26, "blocked", [23]),
    iss(99, "eligible", [26]), iss(40, "eligible", [29]), iss(41, "eligible", [41]),
  ]);
  assert.deepEqual(s.doable, [29, 40, 41], "a self-reference is ignored, not a cycle");
  assert.deepEqual(s.waiting_human.map((w) => w.n), [23, 26, 58, 99]);
});

test("simulate: a long chain dominates; lanes and dependencies are honoured", () => {
  const deps = new Map([[10, []], [11, [10]], [12, [11]], [13, [12]], [1, []], [2, []], [3, []]]);
  const doable = [1, 2, 3, 10, 11, 12, 13];
  const cost = new Map(doable.map((n) => [n, 1]));
  assert.equal(simulate(doable, deps, cost, 2), 4); // chain of 4; independent work fits beside it
  assert.equal(simulate(doable, deps, cost, 1), 7);
  assert.equal(simulate(doable, deps, cost, 3), 4);
  // two independent chains of 3 on 3 lanes: not 6/3 = 2 but 3
  const d2 = new Map([[1, []], [2, [1]], [3, [2]], [4, []], [5, [4]], [6, [5]]]);
  assert.equal(simulate([1, 2, 3, 4, 5, 6], d2, new Map([1, 2, 3, 4, 5, 6].map((n) => [n, 1])), 3), 3);
  assert.equal(simulate([], new Map(), new Map(), 3), 0);
  // a cycle never starts and does not hang
  const cyc = new Map([[1, [2]], [2, [1]], [3, []]]);
  assert.equal(simulate([1, 2, 3], cyc, new Map([[1, 1], [2, 1], [3, 5]]), 2), 5);
});

test("eta gates: needs 3 merges in 7 days and busy hours; q_effort needs 5 completed issues", () => {
  const gh = { issues: [iss(100, "eligible"), iss(101, "eligible")] };
  const base = [];
  for (let i = 1; i <= 2; i++) base.push(stage(NOW - i * H, i, 1800), out(NOW - i * H + 5, i, "merged"));
  assert.equal(computeEta(mk(base), gh, NOW).eta, null, "2 merges");
  base.push(stage(NOW - 8 * DAY, 9, 3600), out(NOW - 8 * DAY + 5, 9, "merged")); // outside the window
  assert.equal(computeEta(mk(base), gh, NOW).eta, null, "a merge older than 7 days does not count");
  base.push(stage(NOW - 3 * H, 3, 1800), out(NOW - 3 * H + 5, 3, "merged"));
  const e = computeEta(mk(base), gh, NOW).eta;
  assert.ok(e);
  assert.equal(e.q_effort, null, "4 completed issues with effort is below 5");
  assert.ok(e.q_rate > 1 && e.p80_h > e.p50_h, "P80 still has the rate's uncertainty");
  assert.equal(e.doable, 2);
  // 3 merges / 1.5 busy lane-hours = 2 per lane-hour; merges per issue 1; 2 issues on 3 lanes = 0.5 h
  assert.equal(e.rate_per_lane_h, 2); assert.equal(e.p50_h, 0.5);
  assert.equal(computeMetrics(mk(base), gh, NOW).eta_h, 0.5);
  for (let i = 20; i < 22; i++) base.push(stage(NOW - i * 60, i, 600), out(NOW - i * 60 + 5, i, "merged"));
  assert.ok(computeEta(mk(base), gh, NOW).eta.q_effort !== null);
  // no stage time at all: busy 0, c undefined
  assert.equal(computeEta(mk([out(NOW - 5, 1, "merged"), out(NOW - 4, 2, "merged"), out(NOW - 3, 3, "merged")]), gh, NOW).eta, null);
});

test("rate dispersion: steady days are Poisson, an incident day widens P80", () => {
  // 7 days, 10 busy lane-h and 2 merges each: exactly c x busy every day -> phi floors at 1
  const steady = [];
  for (let d = 0; d < 7; d++) {
    const t = NOW - 7 * DAY + d * DAY + H;
    steady.push(stage(t, 100 + d, 10 * H), out(t + 60, 100 + d, "merged"), out(t + 120, 200 + d, "merged"));
  }
  assert.deepEqual(rateDispersion(mk(steady), NOW, 0.2), { phi: 1, days: 7 });
  // 4 busy days of 10 lane-h, merges 6 6 0 0: c = 0.3, expected 3 each, chi-square 12 over 3 df -> phi 4
  const bursty = [];
  [6, 6, 0, 0].forEach((k, d) => {
    const t = NOW - 6 * DAY + d * DAY + H;
    bursty.push(stage(t, 300 + d, 10 * H));
    for (let j = 0; j < k; j++) bursty.push(out(t + 60 + j, 400 + d * 10 + j, "merged"));
  });
  assert.deepEqual(rateDispersion(mk(bursty), NOW, 0.3), { phi: 4, days: 4 });
  const gh = { issues: [iss(1, "eligible"), iss(2, "eligible")] };
  const e = computeEta(mk(bursty), gh, NOW).eta;
  assert.equal(e.dispersion, 4);
  // 12 merges measured, 2 to go, both relative variances x phi
  const qr = Math.exp(Z80 * Math.sqrt(4 * (1 / 12 + 1 / 2)));
  assert.equal(e.q_rate, Math.round(qr * 1000) / 1000);
  assert.equal(e.p80_h, Math.round((1 / 0.3) * qr * 10) / 10, "two issues of 1/c lane-h side by side, x q_rate");
  // the same 12 merges spread evenly: same rate, same P50, narrower P80
  const even = [];
  [3, 3, 3, 3].forEach((k, d) => {
    const t = NOW - 6 * DAY + d * DAY + H;
    even.push(stage(t, 300 + d, 10 * H));
    for (let j = 0; j < k; j++) even.push(out(t + 60 + j, 400 + d * 10 + j, "merged"));
  });
  const ev = computeEta(mk(even), gh, NOW).eta;
  assert.equal(ev.p50_h, e.p50_h);
  assert.equal(ev.dispersion, 1);
  assert.ok(ev.p80_h < e.p80_h);
});

test("rate dispersion: a day with merges but no busy time hands them on; under 3 days is phi 1", () => {
  // day 0: 2 merges, no stage time; day 1: 10 h, 0 merges -> one bucket (2 merges, 10 h)
  const r = mk([
    out(NOW - 7 * DAY + 60, 1, "merged"), out(NOW - 7 * DAY + 120, 2, "merged"),
    stage(NOW - 6 * DAY + 60, 3, 10 * H),
    stage(NOW - 5 * DAY + 60, 4, 10 * H), out(NOW - 5 * DAY + 120, 4, "merged"), out(NOW - 5 * DAY + 180, 5, "merged"),
    stage(NOW - 4 * DAY + 60, 6, 10 * H), out(NOW - 4 * DAY + 120, 6, "merged"), out(NOW - 4 * DAY + 180, 7, "merged"),
    out(NOW - 60, 8, "merged"), out(NOW - 30, 9, "merged"), // last day, no busy time: back to the last bucket
  ]);
  // buckets (2, 10 h), (2, 10 h), (4, 10 h): c = 8 / 30; expected 8/3 each
  const c = 8 / 30, ex = c * 10;
  const x2 = ((2 - ex) ** 2 * 2 + (4 - ex) ** 2) / ex;
  assert.deepEqual(rateDispersion(r, NOW, c), { phi: Math.max(1, x2 / 2), days: 3 });
  const two = mk([stage(NOW - 2 * DAY, 1, 10 * H), out(NOW - 2 * DAY + 5, 1, "merged"), stage(NOW - H, 2, 10 * H)]);
  assert.deepEqual(rateDispersion(two, NOW, 0.05), { phi: 1, days: 2 });
  // two days of history (the live state on 2026-10-18): phi 1 is used, but not shown as measured
  const r2 = mk([
    stage(NOW - DAY - H, 1, 10 * H), out(NOW - DAY, 1, "merged"), out(NOW - DAY + 1, 2, "merged"),
    stage(NOW - H, 3, 10 * H), out(NOW - 60, 3, "merged"),
  ]);
  const e2 = computeEta(r2, { issues: [iss(1, "eligible")] }, NOW).eta;
  assert.equal(e2.dispersion, null);
  assert.equal(e2.q_rate, Math.round(Math.exp(Z80 * Math.sqrt(1 / 3 + 1 / 1)) * 1000) / 1000);
});

test("eta: effort excludes pick, adopted and unmerged issues; merges_per_issue counts repeat merges", () => {
  const r = mk([
    stage(100, 1, 3600), { ...stage(101, 1, 999), stage: "pick" }, out(102, 1, "merged"),
    stage(110, 2, 7200), out(111, 2, "adopted"), out(112, 2, "merged"),
    stage(120, 3, 1800), out(121, 3, "pr"),
    stage(130, 4, 1800), out(131, 4, "merged"), stage(140, 4, 1800), out(141, 4, "merged"),
  ]);
  assert.deepEqual([...effortByIssue(r)], [[1, 1], [4, 1]]);
  const e = computeEta(r, { issues: [iss(1, "eligible")] }, 150);
  assert.equal(e.merges_per_issue, 4 / 3);
});

test("waste: runs per slot, in-progress stages excluded, pr counts productive", () => {
  const now = 10 * DAY;
  const r = mk([
    stage(now - 100, 1, 3600), out(now - 90, 1, "merged"), // slot 1: 1h productive
    stage(now - 80, 2, 1800), stage(now - 70, 2, 1800), out(now - 60, 2, "no_commit"), // 1h waste
    { ...stage(now - 50, 3, 3600), slot: 2 }, { ...out(now - 40, 3, "pr"), slot: 2 }, // slot 2: 1h productive
    { ...stage(now - 30, 4, 1800), slot: 2 }, { ...out(now - 20, 4, "ci_failed"), slot: 2 }, // 0.5h waste
    stage(now - 10, 5, 9999), // in progress: ignored
    stage(1, 6, 3600), out(2, 6, "stopped"), // older than 7 days: ignored
  ]);
  assert.equal(computeWaste(r, now), 0.75); // 1.5 h waste / 2 h productive
  assert.equal(computeWaste(mk([stage(now - 9, 1, 60), out(now - 8, 1, "blocked")]), now), null);
  assert.equal(computeMetrics(r, { issues: [] }, now).waste_per_productive_h_7d, 0.75);
});

test("waste on the fixtures", () => {
  const w = computeWaste(reader, NOW);
  assert.ok(w > 0.2 && w < 0.8, `waste ${w}`);
  assert.equal(computeMetrics(reader, github, NOW).waste_per_productive_h_7d, w);
});

// ------------------------------------------------------------------ size calibration
const rnd = (() => { let s = 7; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; })();
const feats = (bullets, chars = 500 + bullets * 40) => ({ chars, bullets, checkboxes: 0, epic: 0 });

test("featuresOf counts chars, bullets, checkboxes and epic", () => {
  const body = "intro\n- a\n* b\n1. c\n2) d\n  - [ ] e\n- [x] f\nplain - not\n-nospace";
  assert.deepEqual(featuresOf(body, "[EPIC] big"), { chars: body.length, bullets: 6, checkboxes: 2, epic: 1 });
  assert.deepEqual(featuresOf(null, null), { chars: 0, bullets: 0, checkboxes: 0, epic: 0 });
});

test("size model is off below n = 30 but reports n and flat_mae", () => {
  const s = Array.from({ length: MIN_N - 1 }, (_, i) => ({ effort: 1 + (i % 5), feats: feats(2 + i) }));
  const c = calibrate(s);
  assert.equal(c.model.active, false); assert.equal(c.model.n, MIN_N - 1);
  assert.ok(c.model.flat_mae > 0);
  assert.equal(c.model.feature, null); assert.equal(c.model.mae, null);
  assert.equal(c.factor({ size: { chars: 1, bullets: 1, checkboxes: 0 } }), null);
});

test("size model activates only when a feature beats flat by 15%", () => {
  // effort follows bullets almost exactly: the feature wins by far
  const s = Array.from({ length: 40 }, (_, i) => {
    const b = 1 + (i % 20);
    return { effort: Math.exp(0.2 + 0.9 * Math.log(1 + b)) * (1 + (rnd() - 0.5) * 0.05), feats: feats(b, 300 + ((i * 7919) % 1000)) };
  });
  const c = calibrate(s);
  assert.equal(c.model.active, true); assert.equal(c.model.feature, "bullets");
  assert.ok(c.model.mae <= 0.85 * c.model.flat_mae);
  assert.equal(c.model.n, 40);
  const small = c.factor({ title: "x", size: { chars: 100, bullets: 1, checkboxes: 0 } });
  const big = c.factor({ title: "x", size: { chars: 100, bullets: 19, checkboxes: 0 } });
  assert.ok(small < 1 && big > 1 && big > 2 * small);
  assert.equal(c.factor({ title: "x" }), null, "no size on the issue: flat cost");
  // mean factor over the calibration set is 1
  const mean = s.reduce((a, x) => a + c.factor({ title: "", size: x.feats }), 0) / s.length;
  assert.ok(Math.abs(mean - 1) < 1e-9);

  // effort unrelated to any feature: stays flat
  const noise = Array.from({ length: 40 }, (_, i) => ({ effort: Math.exp(rnd() * 2), feats: feats(1 + ((i * 13) % 17), 200 + ((i * 31) % 900)) }));
  const cn = calibrate(noise);
  assert.equal(cn.model.active, false);
  assert.equal(cn.model.n, 40); assert.ok(cn.model.flat_mae > 0);
  // the rule is the 0.85 ratio on leave-one-out MAE, exactly
  const best = Math.min(...["chars", "bullets", "checkboxes", "epic"].map((f) => looMae(noise, f)));
  assert.ok(best > 0.85 * looMae(noise, null));
});

test("active size model changes per-issue cost; issues without size stay flat", () => {
  const gh = { issues: [
    { ...iss(1, "eligible"), size: { chars: 100, bullets: 1, checkboxes: 0 } },
    { ...iss(2, "eligible"), size: { chars: 100, bullets: 9, checkboxes: 0 } },
    iss(3, "eligible"),
  ] };
  const rows = [];
  for (let i = 1; i <= 4; i++) rows.push(stage(NOW - i * H, 50 + i, 3600), out(NOW - i * H + 5, 50 + i, "merged"));
  const r = mk(rows); // c = 1 per lane-hour, flat cost 1 h
  const flat = computeEta(r, gh, NOW, { control: { agents: 1 } }).eta;
  assert.equal(flat.p50_h, 3);
  const model = { active: true, feature: "bullets", n: 40, flat_mae: 1, mae: 0.5 };
  const factor = (i) => (i.size ? (i.size.bullets === 1 ? 0.5 : 1.5) : null);
  const sized = computeEta(r, gh, NOW, { control: { agents: 1 }, size: { model, factor } }).eta;
  assert.equal(sized.p50_h, 3); // 0.5 + 1.5 + 1 (flat)
  const sized3 = computeEta(r, gh, NOW, { control: { agents: 3 }, size: { model, factor } }).eta;
  assert.equal(sized3.p50_h, 1.5);
  assert.deepEqual(sized3.size_model, model);
  const inactive = computeEta(r, gh, NOW, { control: { agents: 3 }, size: { model: { ...model, active: false }, factor } }).eta;
  assert.equal(inactive.p50_h, 1);
});

test("SizeCalibrator reads the newest run dir per issue through confined readers and caches 10 minutes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hc-size-"));
  const put = (name, issue) => {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, "issue.json"), JSON.stringify(issue));
  };
  const rows = [];
  for (let n = 1; n <= 32; n++) {
    rows.push(stage(1000 + n * 10, n, 3600 * (1 + (n % 4))), out(1005 + n * 10, n, "merged"));
    put(`issue-${n}-20261016T010000Z`, { body: "- a\n", title: "old" });
    put(`issue-${n}-20261017T235959Z-s2`, { body: "- a\n".repeat(n), title: "new" });
  }
  put("issue-5-20261018T000000Z.bak", { body: "ignored" });
  put("issue-7-1800000000", { body: "not a run.sh name" });
  fs.mkdirSync(path.join(dir, "issue-6-20261018T120000Z-s3")); // newest, but unreadable: no issue.json
  const cal = new SizeCalibrator({ logDir: dir, ttlMs: 600000 });
  const r = mk(rows);
  const res = cal.get(r, 0);
  assert.equal(res.model.n, 31, "issue 6's newest dir has no issue.json, so it drops out");
  assert.equal(cal.get(mk([]), 599999), res, "cached");
  assert.notEqual(cal.get(mk([]), 600001), res, "recomputed after the ttl");
  fs.rmSync(dir, { recursive: true });
});
