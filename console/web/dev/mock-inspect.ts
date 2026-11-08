// Dev-only mock for GET /api/slots/:k/inspect (SCHEMA 6.1). Reads the simulator's .sim dirs:
// ui/slots/K.json -> log_dir -> *.jsonl, parsed with the same SS5.2 rules as dev/mock-api.ts.
// plan.json / checklist.json are used when the simulator writes them, otherwise synthesised.
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Ctx } from "./mock-extra";

type J = Record<string, any>;
const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);

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
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out: J[] = [];
  for (const l of text.split("\n")) { if (!l) continue; try { const it = toItem(k, JSON.parse(l)); if (it) out.push(it); } catch { /* partial last line */ } }
  return out;
}

const PHASE_ORDER = ["plan", "build", "verify", "review", "pr", "ci"];

function synthChecklist(reqs: { total: number; done: number } | null, files: J[]): J[] | null {
  if (!reqs || reqs.total < 1) return null;
  const names = ["Roll monthly order totals up to daily", "Validate input ranges and reject NaN", "Add warnings[] for the discount cap", "Test: empty cart edge case", "Test: totals are monotonic in quantity", "Document the pricing rule in docs/", "Update the test fixtures", "Wire it to the /api/checkout endpoint", "Check for regressions over a full year", "Tidy up the error messages"];
  const out: J[] = [];
  for (let i = 0; i < Math.min(reqs.total, names.length); i++) {
    const done = i < reqs.done;
    out.push({ item: names[i], done, evidence: done ? `${files[i % Math.max(1, files.length)]?.path ?? "crates/shop-core/src/lib.rs"}:${40 + i * 17} test_req_${i + 1}` : null });
  }
  return out;
}
function synthPlan(issue: J | null, reqs: string[]): J {
  return {
    decision: "go",
    slice: `${issue?.title ?? "Slice"}\n\nBuild one vertical slice: a pure function in shop-core, one thin endpoint in shop-api, and a test that proves the numbers. No number without a source.`,
    requirements: reqs,
    files: ["crates/shop-core/src/consumption.rs", "crates/shop-api/src/routes/sim.rs"],
    tests: "cargo test -p shop-core --locked",
  };
}

export async function handleInspect(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: Ctx): Promise<boolean> {
  const m = /^\/api\/slots\/([123])\/inspect$/.exec(url.pathname);
  if (!m) return false;
  const k = Number(m[1]);
  const slot = readJson(path.join(ctx.sim, "ui", "slots", `${k}.json`));
  const logDir: string | null = slot?.log_dir ?? null;
  if (!slot || !logDir || !fs.existsSync(logDir)) { ctx.send(res, 404, { error: "no_run" }); return true; }

  // every turn file of this run, in time order
  const turns: J[] = [];
  const perTurn = new Map<string, J[]>();
  for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith(".jsonl"))) {
    const items = parseFile(k, path.join(logDir, f));
    perTurn.set(f, items);
    turns.push({ phase: f.replace(/-\d+\.jsonl$/, ""), file: f, first: items[0]?.t ?? fs.statSync(path.join(logDir, f)).birthtimeMs, last: items.at(-1)?.t ?? 0, items: items.length });
  }
  turns.sort((a, b) => a.first - b.first);

  // files touched across the run
  const touched = new Map<string, J>();
  for (const [, items] of perTurn) {
    for (const it of items) {
      if (it.kind !== "tool" || !it.target || !["edit", "write", "read"].includes(it.tool)) continue;
      const f = touched.get(it.target) ?? { path: it.target, edits: 0, reads: 0, last: 0 };
      if (it.tool === "read") f.reads++; else f.edits++;
      f.last = Math.max(f.last, it.t);
      touched.set(it.target, f);
    }
  }
  const files = [...touched.values()].sort((a, b) => b.last - a.last);

  const turnFile: string | null = slot.turn?.events ?? null;
  const turn = turnFile ? { phase: slot.turn.phase, started: slot.turn.started, items: parseFile(k, turnFile).slice(-2000) } : null;

  const reqTexts = ["Pure function, no IO", "Input ranges validated", "warnings[], not a silent clamp", "Oracle tests pass", "Formula documented"].slice(0, Math.max(0, Math.min(5, slot.requirements?.total ?? 3)));
  const checklist = readJson(path.join(logDir, "checklist.json")) ?? synthChecklist(slot.requirements ?? null, files);
  const plan = readJson(path.join(logDir, "plan.json")) ?? (slot.stage && PHASE_ORDER.includes(slot.stage) ? synthPlan(slot.issue ?? null, reqTexts) : null);

  ctx.send(res, 200, { slot: k, run_id: slot.run_id, stage: slot.stage, issue: slot.issue ? { n: slot.issue.n, title: slot.issue.title, tag: slot.issue.tag, url: slot.issue.url } : null, pr: slot.pr ?? null, ci: slot.ci ?? null, turn, turns, files, checklist, plan });
  return true;
}
