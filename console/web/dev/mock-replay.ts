// Dev-only mock for GET /api/replay and GET /api/replay/:id (SCHEMA 6.2). Reads the simulator's
// `.sim/log/<run dir>/*.jsonl` turn files and `.sim/ui/stats.jsonl`. Never part of the production bundle.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Ctx } from "./mock-extra";

type J = Record<string, any>;
const ID_RE = /^issue-([0-9]+)-([0-9]{8}T[0-9]{6}Z)(?:-s([1-3]))?$/;
const FIXTURE_GH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../contracts/fixtures/ui/github.json");

const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);
const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

// copy of the small parser in mock-api.ts (SCHEMA 5.2)
function toItem(k: number, e: J): J | null {
  const p = e.part ?? {};
  if (e.type === "tool_use") {
    const i = p.state?.input ?? {};
    let target: string;
    switch (p.tool) {
      case "bash": target = cut(String(i.command ?? "").split("\n")[0], 120); break;
      case "read": case "edit": case "write": target = cut(String(i.filePath ?? "").replace(`/home/factory/s${k}/work/`, "").replace("/home/factory/work/", ""), 120); break;
      case "grep": case "glob": target = cut(i.pattern, 120); break;
      case "task": target = cut(i.description, 120); break;
      case "webfetch": target = cut(i.url, 120); break;
      default: target = cut(p.state?.title, 120);
    }
    return { t: e.timestamp, kind: "tool", tool: p.tool, target, text: null, status: p.state?.status ?? null, tokens: null };
  }
  if (e.type === "text") return { t: e.timestamp, kind: "text", tool: null, target: null, text: cut(p.text, 200), status: null, tokens: null };
  if (e.type === "step_finish") return { t: e.timestamp, kind: "step", tool: null, target: null, text: null, status: null, tokens: { in: p.tokens?.input ?? 0, out: p.tokens?.output ?? 0 } };
  if (e.type === "error") return { t: e.timestamp, kind: "error", tool: null, target: null, text: cut(e.error?.data?.message, 200), status: null, tokens: null };
  return null;
}
function parseFile(k: number, file: string): J[] {
  let txt = "";
  try { txt = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out: J[] = [];
  for (const l of txt.split("\n")) { if (!l) continue; try { const it = toItem(k, JSON.parse(l)); if (it) out.push(it); } catch { /* partial or bad line */ } }
  return out;
}

/** phase (turn file name without `-N.jsonl`) -> stage, SCHEMA 3.1 */
function stageOfPhase(phase: string): string {
  if (phase === "plan") return "plan";
  if (/^(verify|vfix|fix)/.test(phase)) return "verify";
  if (/^review/.test(phase)) return "review";
  if (/^(pr|conflict)/.test(phase)) return "pr";
  if (/^ci/.test(phase)) return "ci";
  return "build";
}

interface Run { id: string; issue: number; slot: number; items: J[]; turns: string[]; started: number; ended: number }

function loadRun(sim: string, id: string): Run | null {
  const m = ID_RE.exec(id);
  if (!m) return null;
  const dir = path.join(sim, "log", id);
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return null; }
  const slot = m[3] ? Number(m[3]) : 1;
  const parts = files.map((f) => {
    const phase = f.replace(/-\d+\.jsonl$/, "");
    return { phase, items: parseFile(slot, path.join(dir, f)).map((it): J => ({ ...it, phase })) };
  }).filter((p) => p.items.length);
  parts.sort((a, b) => a.items[0].t - b.items[0].t);
  const items = parts.flatMap((p) => p.items).sort((a, b) => a.t - b.t).slice(0, 5000);
  if (!items.length) return { id, issue: Number(m[1]), slot, items, turns: [], started: 0, ended: 0 };
  return { id, issue: Number(m[1]), slot, items, turns: parts.map((p) => p.phase), started: Math.floor(items[0].t / 1000), ended: Math.ceil(items.at(-1)!.t / 1000) };
}

function stats(sim: string): J[] {
  let raw = "";
  try { raw = fs.readFileSync(path.join(sim, "ui", "stats.jsonl"), "utf8"); } catch { return []; }
  const out: J[] = [];
  for (const l of raw.split("\n")) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* partial last line */ } }
  return out;
}

function meta(sim: string, n: number): { title: string; tag: string | null } {
  for (const f of [path.join(sim, "ui", "github.json"), FIXTURE_GH]) {
    const g = readJson(f);
    const i = (g?.issues ?? []).find((x: J) => x.n === n);
    if (i) return { title: String(i.title), tag: i.tag ?? null };
  }
  return { title: `issue #${n}`, tag: null };
}

function outcomeOf(st: J[], r: Run): J | null {
  return st.find((s) => s.kind === "outcome" && s.issue === r.issue && s.ts >= r.started - 60 && s.ts <= r.ended + 600) ?? null;
}

function timeline(st: J[], r: Run, outcome: J | null): J[] {
  const tl: J[] = [{ t: r.started * 1000, stage: "pick" }];
  const seen = new Set<string>();
  for (const it of r.items) {
    const key = it.phase as string;
    if (seen.has(key)) continue;
    seen.add(key);
    tl.push({ t: it.t, stage: stageOfPhase(key) });
  }
  for (const s of st) {
    if (s.kind !== "stage" || s.issue !== r.issue || s.ts < r.started - 60 || s.ts > r.ended + 600) continue;
    if (["ci", "merge", "deploy", "pr"].includes(s.stage)) tl.push({ t: Math.round((s.ts - (Number(s.secs) || 0)) * 1000), stage: s.stage });
  }
  if (outcome?.outcome === "merged") tl.push({ t: Math.max(outcome.ts * 1000, r.ended * 1000), stage: "live" });
  tl.sort((a, b) => a.t - b.t);
  // collapse consecutive duplicates
  return tl.filter((e, i) => i === 0 || e.stage !== tl[i - 1].stage);
}

export async function handleReplay(req: IncomingMessage, res: ServerResponse, url: URL, ctx: Ctx): Promise<boolean> {
  if (req.method !== "GET" || !url.pathname.startsWith("/api/replay")) return false;
  const p = url.pathname;
  const logDir = path.join(ctx.sim, "log");
  if (p === "/api/replay") {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(logDir).filter((d) => ID_RE.test(d)); } catch { /* no log yet */ }
    const st = stats(ctx.sim);
    const runs = dirs.map((id) => loadRun(ctx.sim, id)).filter((r): r is Run => !!r && r.items.length > 0).map((r) => {
      const o = outcomeOf(st, r);
      const mt = meta(ctx.sim, r.issue);
      return { id: r.id, issue: r.issue, tag: mt.tag, title: mt.title, slot: r.slot, started: r.started, ended: r.ended, outcome: o?.outcome ?? null, turns: r.turns, items: r.items.length };
    });
    runs.sort((a, b) => b.started - a.started);
    ctx.send(res, 200, { runs: runs.slice(0, 50) });
    return true;
  }
  const m = /^\/api\/replay\/([^/]+)$/.exec(p);
  if (!m) return false;
  const id = decodeURIComponent(m[1]);
  if (!ID_RE.test(id)) { ctx.send(res, 400, { error: "invalid" }); return true; }
  const r = loadRun(ctx.sim, id);
  if (!r) { ctx.send(res, 404, { error: "not_found" }); return true; }
  const st = stats(ctx.sim);
  const o = outcomeOf(st, r);
  const mt = meta(ctx.sim, r.issue);
  ctx.send(res, 200, { id: r.id, issue: r.issue, tag: mt.tag, title: mt.title, slot: r.slot, outcome: o?.outcome ?? null, url: o?.url ?? null, started: r.started, ended: r.ended, items: r.items, timeline: timeline(st, r, o) });
  return true;
}
