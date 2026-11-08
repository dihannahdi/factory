// DEV ONLY. A tiny stand-in for the console backend so the UI can be built against
// `node console/dev/simulate.mjs --dir .sim`. Implements the contract in contracts/SCHEMA.md
// section 5 (snapshot, SSE, the POSTs) by reading and writing the simulator's .sim/ files.
// vite.config.ts adds this plugin for `vite serve` only; it is never part of the production bundle.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extraRoutes } from "./mock-extra";

type J = Record<string, any>;
const SIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.sim");
const UI = path.join(SIM, "ui"), CTL = path.join(SIM, "ctl");
const READONLY = process.env.MOCK_READONLY === "1";

const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
function writeJson(file: string, v: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, file);
}
const nowS = () => Math.floor(Date.now() / 1000);
const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const DEFAULT_CONTROL = { v: 1, agents: 1, models: ["opencode/deepseek-v4.1-flash-free"], model_mode: "ordered", paused: false, queue: [], skip: [], resume_ack: null };
const control = (): J => ({ ...DEFAULT_CONTROL, ...(readJson(path.join(CTL, "control.json")) ?? {}) });
const blankSlot = (k: number): J => ({
  v: 1, slot: k, run_id: null, state: "parked", stage: null, sub: "", issue: null, pr: null, model: null, session: null, turn: null,
  stage_started: null, issue_started: null, tokens: null, requirements: null, ci: null, steer: { pending: null, last: null },
  interrupt: null, note: "", effective_agents: 0, log_dir: null, updated: 0,
});
const slot = (k: number): J => readJson(path.join(UI, "slots", `${k}.json`)) ?? blankSlot(k);

function stats(): J[] {
  let raw = "";
  try { raw = fs.readFileSync(path.join(UI, "stats.jsonl"), "utf8"); } catch { return []; }
  const out: J[] = [];
  for (const l of raw.split("\n")) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* partial last line */ } }
  return out;
}

function metrics(gh: J | null, st: J[]): J {
  const now = nowS();
  const merged = st.filter((s) => s.kind === "outcome" && s.outcome === "merged");
  const m24 = merged.filter((s) => s.ts > now - 86400).length, m7 = merged.filter((s) => s.ts > now - 7 * 86400).length;
  const m48 = merged.filter((s) => s.ts > now - 48 * 3600).length;
  const remaining = (gh?.issues ?? []).filter((i: J) => ["queued", "eligible", "running", "blocked"].includes(i.class)).length;
  const tp = m48 / 48;
  const success: J = {};
  for (const s of st.filter((x) => x.kind === "outcome" && ["pr", "merged", "no_commit", "verify_failed", "ci_failed"].includes(x.outcome) && x.model)) {
    const e = (success[s.model] ??= { attempts: 0, merged: 0, rate: 0 });
    e.attempts++; if (s.outcome === "merged") e.merged++;
    e.rate = e.merged / e.attempts;
  }
  const by: Record<string, number[]> = {};
  for (const s of st.filter((x) => x.kind === "stage" && x.result === "ok")) (by[s.stage] ??= []).push(s.secs);
  const med: J = {};
  for (const [k, v] of Object.entries(by)) { v.sort((a, b) => a - b); med[k] = Math.round((v[Math.floor(v.length / 2)] / 60) * 100) / 100; }
  const bn = Object.entries(med).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] ?? null;
  const day0 = new Date(Date.now() + 7 * 3600e3); day0.setUTCHours(0, 0, 0, 0);
  const since = day0.getTime() / 1000 - 7 * 3600;
  const tok = { input: 0, output: 0, cache_read: 0 };
  for (const s of st.filter((x) => x.kind === "call" && x.ts >= since && x.tokens)) { tok.input += s.tokens.input ?? 0; tok.output += s.tokens.output ?? 0; tok.cache_read += s.tokens.cache_read ?? 0; }
  return {
    merged_24h: m24, merged_7d: m7, remaining, throughput_per_h: tp, eta_h: m48 >= 3 && tp > 0 ? remaining / tp : null, eta: null, waste_per_productive_h_7d: null,
    success, stage_median_min: med, bottleneck: bn, tokens_today: tok,
    rate_limited_1h: st.filter((x) => x.kind === "call" && x.rate_limited && x.ts > now - 3600).length,
  };
}

// ---------------------------------------------------------------- activity (SS5.2)
interface Tail { path: string | null; pos: number; carry: string; items: J[] }
const tails: Tail[] = [1, 2, 3].map(() => ({ path: null, pos: 0, carry: "", items: [] }));
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
function parseLines(k: number, text: string): J[] {
  const out: J[] = [];
  for (const l of text.split("\n")) { if (!l) continue; try { const it = toItem(k, JSON.parse(l)); if (it) out.push(it); } catch { /* skip */ } }
  return out;
}
/** Returns an activity event when something changed for this slot. */
function pollActivity(k: number, s: J): J | null {
  const T = tails[k - 1];
  const file: string | null = s.turn?.events ?? null;
  if (!file) return null;
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return null; }
  const fd = fs.openSync(file, "r");
  try {
    if (file !== T.path) {
      const start = Math.max(0, size - 256 * 1024);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let txt = buf.toString("utf8");
      if (start > 0) txt = txt.slice(txt.indexOf("\n") + 1);
      const lastNl = txt.lastIndexOf("\n");
      T.carry = lastNl >= 0 ? txt.slice(lastNl + 1) : txt;
      T.path = file; T.pos = size;
      const items = parseLines(k, lastNl >= 0 ? txt.slice(0, lastNl) : "").slice(-50);
      return { slot: k, items, reset: true };
    }
    if (size <= T.pos) return null;
    const buf = Buffer.alloc(size - T.pos);
    fs.readSync(fd, buf, 0, buf.length, T.pos);
    T.pos = size;
    const txt = T.carry + buf.toString("utf8");
    const lastNl = txt.lastIndexOf("\n");
    if (lastNl < 0) { T.carry = txt; return null; }
    T.carry = txt.slice(lastNl + 1);
    const items = parseLines(k, txt.slice(0, lastNl));
    return items.length ? { slot: k, items, reset: false } : null;
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------- snapshot
const activityCache: Record<string, J[]> = { "1": [], "2": [], "3": [] };
function pump(): J[] {
  const evs: J[] = [];
  for (const k of [1, 2, 3]) {
    const a = pollActivity(k, slot(k));
    if (a) {
      activityCache[String(k)] = a.reset ? a.items.slice(-50) : [...activityCache[String(k)], ...a.items].slice(-50);
      evs.push(a);
    }
  }
  return evs;
}
function snapshot(): J {
  const gh = readJson(path.join(UI, "github.json"));
  const st = stats();
  return {
    v: 1, now: nowS(), readonly: READONLY, control: control(), slots: [1, 2, 3].map(slot),
    activity: activityCache, github: gh, models: readJson(path.join(UI, "models.json")),
    halt: readJson(path.join(UI, "halt.json")), consumed: readJson(path.join(UI, "consumed.json")) ?? {},
    metrics: metrics(gh, st),
    recent: st.filter((s) => s.kind === "outcome").slice(-30).reverse().map((s) => ({ ts: s.ts, issue: s.issue, slot: s.slot ?? 1, outcome: s.outcome, model: s.model ?? null, url: s.url ?? null })),
  };
}

// ---------------------------------------------------------------- http helpers
const send = (res: ServerResponse, code: number, body?: unknown) => {
  res.statusCode = code;
  if (body !== undefined) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); } else res.end();
};
async function readBody(req: IncomingMessage): Promise<J | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return null; }
}

function postControl(body: J): { code: number; body: J } {
  const c = control();
  if ("agents" in body) { if (!Number.isInteger(body.agents) || body.agents < 0 || body.agents > 3) return { code: 400, body: { error: "invalid", field: "agents" } }; c.agents = body.agents; }
  if ("models" in body) {
    if (!Array.isArray(body.models) || body.models.length < 1 || body.models.length > 5 || !body.models.every((m: unknown) => typeof m === "string" && /^opencode\/[a-z0-9][a-z0-9._-]{0,63}$/.test(m))) return { code: 400, body: { error: "invalid", field: "models" } };
    c.models = body.models;
  }
  if ("model_mode" in body) { if (!["ordered", "auto"].includes(body.model_mode)) return { code: 400, body: { error: "invalid", field: "model_mode" } }; c.model_mode = body.model_mode; }
  if ("paused" in body) { if (typeof body.paused !== "boolean") return { code: 400, body: { error: "invalid", field: "paused" } }; c.paused = body.paused; }
  if ("resume_ack" in body) c.resume_ack = body.resume_ack;
  c.updated_at = iso();
  writeJson(path.join(CTL, "control.json"), c);
  return { code: 200, body: { control: c } };
}
function postIssue(n: number, body: J): { code: number; body: J } {
  const gh = readJson(path.join(UI, "github.json"));
  if (!gh?.issues?.some((i: J) => i.n === n)) return { code: 404, body: { error: "not_found" } };
  const c = control();
  c.queue = (c.queue ?? []).filter((q: J) => q.n !== n);
  switch (body.action) {
    case "queue": c.queue.push({ n, at: iso() }); c.skip = (c.skip ?? []).filter((x: number) => x !== n); break;
    case "unqueue": break;
    case "skip": if (!c.skip.includes(n)) c.skip.push(n); break;
    case "unskip": c.skip = (c.skip ?? []).filter((x: number) => x !== n); break;
    default: return { code: 400, body: { error: "invalid", field: "action" } };
  }
  c.updated_at = iso();
  writeJson(path.join(CTL, "control.json"), c);
  return { code: 200, body: { control: c } };
}
function postInterrupt(k: number, body: J): { code: number; body: J } {
  if (![1, 2, 3].includes(k)) return { code: 400, body: { error: "invalid", field: "slot" } };
  const s = slot(k);
  if (!s.run_id) return { code: 409, body: { error: "no_run" } };
  if (body.action !== "stop" && body.action !== "steer") return { code: 400, body: { error: "invalid", field: "action" } };
  const id = crypto.randomUUID();
  const it: J = { v: 1, id, run_id: s.run_id, action: body.action, skip: body.skip === true, message: "", at: iso() };
  if (body.action === "steer") {
    const m = typeof body.message === "string" ? body.message.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "") : "";
    if (m.length < 1 || m.length > 2000) return { code: 400, body: { error: "invalid", field: "message" } };
    it.message = m;
  }
  writeJson(path.join(CTL, `interrupt-${k}.json`), it);
  if (body.action === "stop" && it.skip && s.issue) { const c = control(); if (!c.skip.includes(s.issue.n)) c.skip.push(s.issue.n); writeJson(path.join(CTL, "control.json"), c); }
  return { code: 202, body: { id } };
}

export function mockApi(): Plugin {
  return {
    name: "factory-mock-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (!url.pathname.startsWith("/api/")) return next();
        const p = url.pathname;
        if (req.method === "GET" && p === "/api/health") return send(res, 200, { ok: true });
        if (req.method === "GET" && (await extraRoutes(req, res, url, { sim: SIM, send }))) return;
        if (req.method === "GET" && p === "/api/state") { pump(); return send(res, 200, snapshot()); }
        if (req.method === "GET" && p === "/api/stream") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
          const emit = (ev: string, data: unknown) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
          res.write("retry: 3000\n\n");
          pump();
          const snap = snapshot();
          emit("snapshot", snap);
          const last = new Map<string, string>();
          const remember = (k: string, v: unknown) => last.set(k, JSON.stringify(v));
          snap.slots.forEach((s: J) => remember(`slot${s.slot}`, s));
          for (const k of ["control", "github", "models", "metrics", "halt", "recent", "consumed"]) remember(k, snap[k]);
          const tick = setInterval(() => {
            for (const a of pump()) emit("activity", a);
            const s = snapshot();
            s.slots.forEach((x: J) => { const j = JSON.stringify(x); if (last.get(`slot${x.slot}`) !== j) { last.set(`slot${x.slot}`, j); emit("slot", x); } });
            for (const k of ["control", "github", "models", "metrics", "halt", "recent", "consumed"]) {
              const j = JSON.stringify(s[k]);
              if (last.get(k) !== j) { last.set(k, j); emit(k, s[k]); }
            }
          }, 1000);
          const ping = setInterval(() => res.write(": ping\n\n"), 15000);
          req.on("close", () => { clearInterval(tick); clearInterval(ping); });
          return;
        }
        if (req.method === "POST") {
          if (p === "/api/login") { await readBody(req); res.setHeader("Set-Cookie", "mock=1; Path=/; HttpOnly; SameSite=Strict"); return send(res, 204); }
          if (p === "/api/logout") return send(res, 204);
          if (READONLY) return send(res, 403, { error: "readonly" });
          const body = await readBody(req);
          if (!body) return send(res, 400, { error: "invalid" });
          let m: RegExpExecArray | null;
          if (p === "/api/control") { const r = postControl(body); return send(res, r.code, r.body); }
          if ((m = /^\/api\/issues\/(\d+)$/.exec(p))) { const r = postIssue(Number(m[1]), body); return send(res, r.code, r.body); }
          if ((m = /^\/api\/slots\/(\d)\/interrupt$/.exec(p))) { const r = postInterrupt(Number(m[1]), body); return send(res, r.code, r.body); }
        }
        return send(res, 404, { error: "not_found" });
      });
    },
  };
}
