// GET /api/slots/:k/inspect (SCHEMA 6.1): typed fetch, field-by-field repair, and the small pure
// helpers the drawer and the station hits share. Every string is untrusted text, never markup.
// Rule learned the hard way: one odd field must never reject the whole payload.
import { request } from "./api";
import type { Item } from "./types";

export interface InspectIssue { n: number; title: string; tag: string | null; url: string | null }
export interface InspectPr { n: number; url: string | null; head: string | null }
export interface TurnRef { phase: string; file: string; first: number; last: number; items: number }
export interface FileTouch { path: string; edits: number; reads: number; last: number }
export interface CheckItem { item: string; done: boolean; evidence: string | null }
export interface PlanInfo { decision: string | null; slice: string | null; requirements: string[]; files: string[]; tests: string | null }
export interface InspectData {
  slot: number;
  run_id: string | null;
  stage: string | null;
  issue: InspectIssue | null;
  pr: InspectPr | null;
  turn: { phase: string; started: number | null; items: Item[] } | null;
  turns: TurnRef[];
  files: FileTouch[];
  checklist: CheckItem[] | null;
  plan: PlanInfo | null;
}

export const ITEM_CAP = 2000;
export const DOM_CAP = 400;

type R = Record<string, unknown>;
const isObj = (v: unknown): v is R => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int0 = (v: unknown): number => { const n = num(v); return n == null || n < 0 ? 0 : Math.floor(n); };
const str = (v: unknown, max = 2000): string | null => (typeof v === "string" ? v.slice(0, max) : null);
/** Strip control characters (keeps tab/newline out too: every readout here is one line). */
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
const line = (v: unknown, max = 400): string | null => { const s = str(v, max * 2); return s == null ? null : clean(s).slice(0, max); };
const httpsOnly = (v: unknown): string | null => { const s = str(v, 600); return s != null && /^https:\/\/[^\s]+$/.test(s) ? s : null; };

const KINDS = new Set(["tool", "text", "step", "error"]);

/** One activity item, repaired. null only when it cannot be placed on the timeline at all. */
export function sanitizeItem(raw: unknown): Item | null {
  if (!isObj(raw)) return null;
  const t = num(raw.t);
  if (t == null || t <= 0) return null;
  let kind = typeof raw.kind === "string" && KINDS.has(raw.kind) ? (raw.kind as Item["kind"]) : null;
  if (kind == null) kind = raw.tool != null ? "tool" : raw.text != null ? "text" : null;
  if (kind == null) return null;
  const tk = isObj(raw.tokens) ? { in: int0(raw.tokens.in), out: int0(raw.tokens.out) } : null;
  return {
    t,
    kind,
    tool: line(raw.tool, 40),
    target: line(raw.target, 160),
    text: line(raw.text, 260),
    status: line(raw.status, 24),
    tokens: tk,
  };
}

export function sanitizeItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  const out: Item[] = [];
  for (const r of raw) { const it = sanitizeItem(r); if (it) out.push(it); }
  return out.slice(-ITEM_CAP);
}

function sanitizeIssue(raw: unknown): InspectIssue | null {
  if (!isObj(raw)) return null;
  const n = num(raw.n);
  if (n == null) return null;
  return { n, title: line(raw.title, 200) ?? "", tag: line(raw.tag, 24), url: httpsOnly(raw.url) };
}
function sanitizePr(raw: unknown): InspectPr | null {
  if (!isObj(raw)) return null;
  const n = num(raw.n);
  if (n == null) return null;
  return { n, url: httpsOnly(raw.url), head: line(raw.head, 64) };
}
function sanitizeTurns(raw: unknown): TurnRef[] {
  if (!Array.isArray(raw)) return [];
  const out: TurnRef[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const file = line(r.file, 120);
    const first = num(r.first), last = num(r.last);
    out.push({ phase: line(r.phase, 24) ?? (file ? file.replace(/-\d+\.jsonl$/, "") : "?"), file: file ?? "", first: first ?? last ?? 0, last: last ?? first ?? 0, items: int0(r.items) });
  }
  return out.slice(-200);
}
function sanitizeFiles(raw: unknown): FileTouch[] {
  if (!Array.isArray(raw)) return [];
  const out: FileTouch[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const p = line(r.path, 300);
    if (!p) continue;
    out.push({ path: p, edits: int0(r.edits), reads: int0(r.reads), last: num(r.last) ?? 0 });
  }
  return out.slice(0, 400);
}
function sanitizeChecklist(raw: unknown): CheckItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CheckItem[] = [];
  for (const r of raw) {
    if (typeof r === "string") { const s = line(r, 300); if (s) out.push({ item: s, done: false, evidence: null }); continue; }
    if (!isObj(r)) continue;
    const item = line(r.item ?? r.text ?? r.title, 300);
    if (!item) continue;
    out.push({ item, done: r.done === true, evidence: line(r.evidence, 300) });
  }
  return out.slice(0, 200);
}
function strList(raw: unknown, max = 60): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) { const s = line(typeof r === "string" ? r : isObj(r) ? (r.text ?? r.item ?? r.title) : null, 400); if (s) out.push(s); }
  return out.slice(0, max);
}
function sanitizePlan(raw: unknown): PlanInfo | null {
  if (!isObj(raw)) return null;
  const sliceRaw = str(raw.slice, 4000);
  const testsRaw = raw.tests;
  return {
    decision: line(raw.decision, 40),
    slice: sliceRaw == null ? null : sliceRaw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim(),
    requirements: strList(raw.requirements),
    files: strList(raw.files),
    tests: Array.isArray(testsRaw) ? strList(testsRaw).join(" · ") || null : line(testsRaw, 600),
  };
}

/** Repair the whole payload field by field. null only when the body is not an object at all. */
export function sanitizeInspect(raw: unknown): InspectData | null {
  if (!isObj(raw)) return null;
  let turn: InspectData["turn"] = null;
  if (isObj(raw.turn)) turn = { phase: line(raw.turn.phase, 24) ?? "", started: num(raw.turn.started), items: sanitizeItems(raw.turn.items) };
  return {
    slot: int0(raw.slot),
    run_id: line(raw.run_id, 80),
    stage: line(raw.stage, 16),
    issue: sanitizeIssue(raw.issue),
    pr: sanitizePr(raw.pr),
    turn,
    turns: sanitizeTurns(raw.turns),
    files: sanitizeFiles(raw.files),
    checklist: sanitizeChecklist(raw.checklist),
    plan: sanitizePlan(raw.plan),
  };
}

export type InspectResult =
  | { ok: true; data: InspectData }
  | { ok: false; reason: "no_run" | "offline" | "auth" | "error" };

export async function fetchInspect(k: number): Promise<InspectResult> {
  const r = await request("GET", `/api/slots/${k}/inspect`);
  if (r.status === 0) return { ok: false, reason: "offline" };
  if (r.status === 401) return { ok: false, reason: "auth" };
  if (r.status === 404) return { ok: false, reason: "no_run" };
  if (!r.ok) return { ok: false, reason: "error" };
  const data = sanitizeInspect(r.data);
  return data ? { ok: true, data } : { ok: false, reason: "error" };
}

// ---------------------------------------------------------------- transcript helpers

export function itemKey(it: Item): string {
  return `${it.t}|${it.kind}|${it.tool ?? ""}|${it.target ?? it.text ?? ""}`;
}

/**
 * Merge `incoming` into `base`: dedupe by timestamp (+ content, so two items of one millisecond both
 * survive), oldest first, newest `cap` kept. Items older than `floor` (ms) are dropped: they belong to
 * a previous turn. Returns `base` itself when nothing changed, so a $state.raw assignment is a no-op.
 */
export function mergeItems(base: Item[], incoming: Item[], floor = 0, cap = ITEM_CAP): Item[] {
  if (!incoming.length) return base;
  const seen = new Set<string>();
  for (const it of base) seen.add(itemKey(it));
  const add: Item[] = [];
  for (const it of incoming) {
    if (it.t < floor) continue;
    const k = itemKey(it);
    if (seen.has(k)) continue;
    seen.add(k);
    add.push(it);
  }
  if (!add.length) return base;
  const lastT = base.length ? base[base.length - 1].t : 0;
  const ordered = add.every((a) => a.t >= lastT) ? [...base, ...add.sort((a, b) => a.t - b.t)] : [...base, ...add].sort((a, b) => a.t - b.t);
  return ordered.length > cap ? ordered.slice(ordered.length - cap) : ordered;
}

/** Tool filter chips: distinct tools by frequency, then "text" and "error" when present. */
export function chipsOf(items: Item[]): { id: string; n: number }[] {
  const c = new Map<string, number>();
  for (const it of items) {
    const id = it.kind === "tool" ? (it.tool || "tool") : it.kind === "step" ? null : it.kind;
    if (id) c.set(id, (c.get(id) ?? 0) + 1);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n }));
}

/** Empty filter = everything (steps included); otherwise only rows whose chip id is selected. */
export function filterItems(items: Item[], active: ReadonlySet<string>): Item[] {
  if (active.size === 0) return items;
  return items.filter((it) => (it.kind === "tool" ? active.has(it.tool || "tool") : it.kind !== "step" && active.has(it.kind)));
}

/** The file the newest read/edit/write item touched, if any. */
export function latestTouch(items: Item[]): { path: string; t: number } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && (it.tool === "edit" || it.tool === "write" || it.tool === "read") && it.target) return { path: it.target, t: it.t };
  }
  return null;
}

export function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

// ---------------------------------------------------------------- click vs drag, hit shapes

/** A press/release pair is a click only when the pointer barely moved (a drag pans the camera instead). */
export function isTap(down: { x: number; y: number }, up: { x: number; y: number }, max = 5): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) < max;
}

/** Convex hull (monotone chain) of projected points: the silhouette of a station's bounding box. */
export function hull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}
