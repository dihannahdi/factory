// GET /api/replay and /api/replay/:id (SCHEMA section 6.2).
import fs from "node:fs";
import path from "node:path";
import { resolveDirInside, listTurns, readJsonFile, readWholeLines } from "./inspect.mjs";

export const ID_RE = /^issue-([0-9]+)-([0-9]{8}T[0-9]{6}Z)(?:-s([1-3]))?$/;
export const MAX_RUNS = 50;
export const MAX_REPLAY_ITEMS = 5000;
const OUTCOME_GRACE_S = 600;
const STATS_MAX = 16 * 1024 * 1024;

/** Stage a turn phase belongs to (SCHEMA 3.1, same table as orchestrator phase_stage). */
export function phaseStage(phase) {
  if (phase === "plan" || phase === "replan") return "plan";
  if (phase === "build" || /^complete/.test(phase) || /^steer/.test(phase)) return "build";
  if (/^fix-(build|complete)/.test(phase) || /^fix-.*verify/.test(phase)) return "verify";
  if (phase === "review" || /^fix-review/.test(phase)) return "review";
  if (/^(merge[0-9]|fix-merge)/.test(phase)) return "pr";
  if (/^(ci[0-9]|fix-ci)/.test(phase)) return "ci";
  return null;
}
// Outcome lines that say how far the run got; the others (blocked, stopped, ...) add no stage.
const OUTCOME_STAGE = { pr: "pr", merged: "live", ci_failed: "ci", ci_wait: "ci", conflict: "pr" };

export function parseId(id) {
  const m = ID_RE.exec(id);
  if (!m) return null;
  const s = m[2];
  const started = Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)) / 1000);
  return { issue: Number(m[1]), slot: m[3] ? Number(m[3]) : 1, hasSlot: !!m[3], started };
}

const statsCache = { file: null, sig: null, lines: [] };
export function readStats(file) {
  let st;
  try { st = fs.lstatSync(file); if (!st.isFile()) return []; } catch { return []; }
  const sig = `${st.size}:${st.mtimeMs}:${st.ino}`;
  if (statsCache.file === file && statsCache.sig === sig) return statsCache.lines;
  const r = readWholeLines(file, STATS_MAX);
  const lines = [];
  if (r) {
    for (const l of r.text.split("\n")) {
      if (!l.trim()) continue;
      try { const o = JSON.parse(l); if (o && typeof o === "object" && Number.isFinite(o.ts)) lines.push(o); } catch { /* skip */ }
    }
  }
  Object.assign(statsCache, { file, sig, lines });
  return lines;
}

function statsFor(lines, info, started, ended) {
  const mine = lines.filter((o) => o.issue === info.issue && (!info.hasSlot || (o.slot ?? 1) === info.slot)
    && o.ts >= started - 5 && o.ts <= ended + OUTCOME_GRACE_S);
  return {
    outcome: mine.find((o) => o.kind === "outcome") ?? null,
    stages: mine.filter((o) => o.kind === "stage" && typeof o.stage === "string"),
  };
}

function summary(realDir, info) {
  const turns = listTurns(realDir);
  const issueJson = readJsonFile(path.join(realDir, "issue.json"), "object");
  const title = typeof issueJson?.title === "string" ? issueJson.title.slice(0, 300) : null;
  const tag = title ? (/^\[([A-Z]+-\d+)\]/.exec(title)?.[1] ?? null) : null;
  let ended = info.started;
  let items = 0;
  for (const t of turns) { items += t.data.items.length; ended = Math.max(ended, Math.floor((t.last ?? t.data.mtimeMs) / 1000)); }
  return { turns, title, tag, ended, items };
}

export function listRuns(logRoot, statsFile) {
  let names;
  try { names = fs.readdirSync(logRoot); } catch { return { runs: [] }; }
  const ids = names.filter((n) => ID_RE.test(n)).map((id) => ({ id, info: parseId(id) }))
    .sort((a, b) => b.info.started - a.info.started || (a.id < b.id ? 1 : -1)).slice(0, MAX_RUNS);
  const stats = readStats(statsFile);
  const runs = [];
  for (const { id, info } of ids) {
    const dir = resolveDirInside(logRoot, path.join(logRoot, id));
    if (!dir) continue;
    const s = summary(dir, info);
    const o = statsFor(stats, info, info.started, s.ended).outcome;
    const phases = [];
    for (const t of s.turns) if (!phases.includes(t.phase)) phases.push(t.phase);
    runs.push({ id, issue: info.issue, tag: s.tag, title: s.title, slot: info.slot, started: info.started, ended: s.ended,
      outcome: o?.outcome ?? null, turns: phases, items: s.items });
  }
  return { runs };
}

/** Body of GET /api/replay/:id, or null when the run dir is missing/unsafe. */
export function getRun(logRoot, statsFile, id) {
  const info = parseId(id);
  if (!info) return null;
  const dir = resolveDirInside(logRoot, path.join(logRoot, id));
  if (!dir) return null;
  const s = summary(dir, info);
  const { outcome, stages } = statsFor(readStats(statsFile), info, info.started, s.ended);

  let items = [];
  const marks = [];
  for (const t of s.turns) {
    let prev = t.first ?? Math.floor(t.data.mtimeMs);
    for (const raw of t.data.items) {
      let it = raw;
      if (it.t === null) it = { ...it, t: prev }; else prev = it.t;
      items.push({ ...it, phase: t.phase });
    }
    const st = phaseStage(t.phase);
    if (st && t.first !== null) marks.push({ t: t.first, stage: st });
  }
  items.sort((a, b) => a.t - b.t); // stable: file order kept for equal t
  items = items.slice(-MAX_REPLAY_ITEMS);
  for (const x of stages) marks.push({ t: Math.round((x.ts - (Number.isFinite(x.secs) ? x.secs : 0)) * 1000), stage: x.stage });
  marks.sort((a, b) => a.t - b.t);
  const timeline = [];
  for (const m of marks) if (!timeline.length || timeline[timeline.length - 1].stage !== m.stage) timeline.push(m);
  const endStage = outcome ? OUTCOME_STAGE[outcome.outcome] : null;
  if (endStage && timeline.length && timeline[timeline.length - 1].stage !== endStage) {
    timeline.push({ t: Math.max(outcome.ts * 1000, timeline[timeline.length - 1].t), stage: endStage });
  }
  const url = typeof outcome?.url === "string" ? outcome.url : null;
  return { id, issue: info.issue, tag: s.tag, title: s.title, slot: info.slot, outcome: outcome?.outcome ?? null, url,
    started: info.started, ended: s.ended, items, timeline };
}
