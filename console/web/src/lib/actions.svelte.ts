// Per-tool actions: every activity item becomes a short physical gesture at the station where the
// lane's agent is. Three layers, all free of reactive state (the component owns the only reactive
// bits), so nothing here can feed back into an effect:
//   classify / itemKey   item -> action kind
//   LaneActions          dedupe, queue (<=3 running, 350 ms apart), clock = the anim loop's `t`
//   draw                 (kind, progress 0..1, anchor) -> a handful of pooled <path> primitives
// Geometry is isometric (same projection as the machine) and painted with the neutral shade ramp;
// the accent colour is never used here, it stays reserved for "where the agent is".
import { COS30, U, project, box } from "./iso";
import type { Face } from "./iso";
import { itemPose, BELT_TOP, beltCy } from "./layout";
import type { Item, Stage } from "./types";

// ------------------------------------------------------------------ classification

export type ActionKind = "read" | "strike" | "test" | "build" | "pump" | "scan" | "drone" | "antenna" | "ink" | "tick";
export interface Action { kind: ActionKind; error: boolean }

/** Duration in seconds of each gesture (600..900 ms). */
export const DURATION: Record<ActionKind, number> = {
  read: 0.8, strike: 0.7, test: 0.9, build: 0.9, pump: 0.75, scan: 0.8, drone: 0.9, antenna: 0.85, ink: 0.65, tick: 0.6,
};
export const MAX_RUNNING = 3;
export const SPACING = 0.35; // seconds between starts in a burst
const MAX_QUEUE = 8;
const MAX_WAIT_MS = 8000; // a queued action older than this is stale (tab was hidden): dropped
const MAX_AGE_MS = 15000; // an item older than this when it arrives is history, not news

const RE_TEST = /\b(cargo\s+(test|nextest)|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|vitest|pytest|jest|go\s+test)\b/i;
const RE_BUILD = /\b(cargo\s+(build|check|clippy)|npm\s+run\s+build|pnpm\s+(run\s+)?build|vite\s+build|astro\s+build|tsc)\b/i;

export function classify(it: Item): Action | null {
  if (it.kind === "step") return { kind: "tick", error: false };
  if (it.kind === "text") return { kind: "ink", error: false };
  if (it.kind === "error") return { kind: "pump", error: true };
  if (it.kind !== "tool") return null;
  const err = it.status === "error";
  const tool = (it.tool ?? "").toLowerCase();
  const target = it.target ?? "";
  switch (tool) {
    case "read": return { kind: "read", error: err };
    case "edit": case "write": case "multiedit": case "patch": case "apply_patch": return { kind: "strike", error: err };
    case "bash": case "shell":
      if (RE_TEST.test(target)) return { kind: "test", error: err };
      if (RE_BUILD.test(target)) return { kind: "build", error: err };
      return { kind: "pump", error: err };
    case "grep": case "glob": case "list": case "ls": case "find": return { kind: "scan", error: err };
    case "task": return { kind: "drone", error: err };
    case "webfetch": case "websearch": return { kind: "antenna", error: err };
    case "todowrite": case "todoread": return { kind: "ink", error: err };
    default: return { kind: "pump", error: err };
  }
}

export const itemKey = (it: Item): string =>
  `${it.t}|${it.kind}|${it.tool ?? ""}|${it.target ?? ""}|${it.tokens ? it.tokens.in + "/" + it.tokens.out : ""}|${it.status ?? ""}`;

// ------------------------------------------------------------------ anchors

/** Where a gesture happens, in screen units relative to the lane group, plus the item's footprint. */
export interface Ctx {
  ox: number; oy: number; // screen position of the item's base centre
  hx: number; hy: number; ht: number; // half sizes and top height of the item (ingot or crate)
  gz: number; // floor height relative to the item base (<= 0)
  rz: number; // progress-ring height relative to the item base
  sig: string;
}

const CRATE = new Set<Stage>(["pr", "ci", "merge", "deploy", "live"]);
const STACK = new Set<Stage>(["merge", "deploy", "live"]);

/** Anchor at the item's base centre of the stage's station (ingot top = base + 0.8, as the press lands). */
export function anchorCtx(stage: Stage | null, k: number, top: number): Ctx {
  const st: Stage = stage ?? "build";
  const [ax, ay, az] = itemPose(st, k, top, 0);
  const crate = CRATE.has(st);
  const [ox, oy] = project(ax, ay, az);
  const floor = STACK.has(st) ? top : 0.31;
  return { ox, oy, hx: crate ? 0.9 : 1.75, hy: crate ? 0.9 : 0.9, ht: crate ? 1.5 : 0.8, gz: floor - az, rz: (STACK.has(st) ? top : 0.34) - az, sig: crate ? "c" : "i" };
}

/** The quench bath: `bash` test runs boil it whatever stage the lane is in. */
export function bathCtx(k: number): Ctx {
  const [ox, oy] = project(22, beltCy(k), BELT_TOP - 0.18);
  return { ox, oy, hx: 1.25, hy: 1.25, ht: 0, gz: 0, rz: 0, sig: "b" };
}

// ------------------------------------------------------------------ engine (plain, non-reactive)

export interface Running { id: number; kind: ActionKind; error: boolean; start: number; dur: number; ctx: Ctx; n: number }
interface Queued { kind: ActionKind; error: boolean; enq: number }

export class LaneActions {
  private seen = new Set<string>();
  private prev: string[] = [];
  private primed = false;
  private lastItems: readonly Item[] | null = null;
  queue: Queued[] = [];
  running: Running[] = [];
  private pendingTicks = 0;
  private lastStart = -10;
  private nextId = 1;
  private tickN = 0;

  /**
   * Items that are news: not seen before and recent. The first list ever seen, and a list that shares
   * nothing with the previous one (a server `reset`), are marked seen without playing.
   */
  fresh(items: readonly Item[], nowMs: number): Item[] {
    if (items === this.lastItems) return [];
    this.lastItems = items;
    const keys = items.map(itemKey);
    if (!this.primed) {
      this.primed = true;
      for (const k of keys) this.seen.add(k);
      this.prev = keys;
      return [];
    }
    const before = new Set(this.prev);
    const reset = this.prev.length > 0 && items.length > 0 && !keys.some((k) => before.has(k));
    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      if (this.seen.has(keys[i])) continue;
      this.seen.add(keys[i]);
      if (!reset && nowMs - items[i].t <= MAX_AGE_MS) out.push(items[i]);
    }
    this.prev = keys;
    if (this.seen.size > 600) {
      let drop = this.seen.size - 300;
      for (const k of this.seen) { if (drop-- <= 0) break; this.seen.delete(k); }
    }
    return out;
  }

  /** Classify the news and (unless `enqueue` is false) line it up. Returns the classified actions. */
  ingest(items: readonly Item[], nowMs: number, enqueue = true): Action[] {
    const out: Action[] = [];
    for (const it of this.fresh(items, nowMs)) {
      const a = classify(it);
      if (!a) continue;
      out.push(a);
      if (!enqueue) continue;
      if (a.kind === "tick") { this.pendingTicks = Math.min(3, this.pendingTicks + 1); continue; }
      this.queue.push({ kind: a.kind, error: a.error, enq: nowMs });
    }
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    return out;
  }

  /** Start what may start at clock `t` (seconds), retire what is done, and return the live actions. */
  advance(t: number, nowMs: number, ctxFor: (kind: ActionKind) => Ctx): Running[] {
    this.running = this.running.filter((r) => t - r.start < r.dur && t >= r.start);
    while (this.queue.length && nowMs - this.queue[0].enq > MAX_WAIT_MS) this.queue.shift();
    const body = this.running.filter((r) => r.kind !== "tick").length;
    if (this.queue.length && body < MAX_RUNNING && t - this.lastStart >= SPACING) {
      const q = this.queue.shift()!;
      this.lastStart = t;
      this.running.push({ id: this.nextId++, kind: q.kind, error: q.error, start: t, dur: DURATION[q.kind], ctx: ctxFor(q.kind), n: 0 });
    }
    while (this.pendingTicks > 0) {
      this.pendingTicks--;
      if (this.running.filter((r) => r.kind === "tick").length >= 3) continue;
      this.running.push({ id: this.nextId++, kind: "tick", error: false, start: t, dur: DURATION.tick, ctx: ctxFor("tick"), n: this.tickN++ });
    }
    return this.running;
  }

  /** Primitives for the live actions at clock `t`. Returns the shared NONE array when idle. */
  frame(t: number, nowMs: number, ctxFor: (kind: ActionKind) => Ctx): Prim[] {
    const run = this.advance(t, nowMs, ctxFor);
    if (run.length === 0) return NONE;
    const out: Prim[] = [];
    for (const r of run) draw(r.kind, (t - r.start) / r.dur, r.ctx, r.error, r.n, false, out);
    return out.length ? out : NONE;
  }
}

// ------------------------------------------------------------------ primitives

/** One pooled <path>: geometry `d` is cached per shape, motion is `tf` (transform) and `o` (opacity). */
export interface Prim { d: string; cls: string; tf: string; o: number; dr?: number }
export const NONE: Prim[] = [];

const C = COS30 * U; // x-axis screen step per world unit
const H = 0.5 * U;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const seg = (p: number, a: number, b: number): number => clamp01((p - a) / (b - a));
const eo = (x: number): number => 1 - (1 - x) * (1 - x) * (1 - x);
const ei = (x: number): number => x * x * x;
const eio = (x: number): number => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const fr = (v: number): number => v - Math.floor(v);

/** World offset (dx, dy, dz) from the item base -> screen position. */
const W = (c: Ctx, dx: number, dy: number, dz: number): [number, number] => [c.ox + (dx - dy) * C, c.oy + (dx + dy) * H - dz * U];
const tl = (e: number, f: number): string => `translate(${r2(e)} ${r2(f)})`;
/** Matrix that lays a 2D (u, v) shape on the floor plane (u -> +x, v -> +y), scaled, optionally turned. */
const floor = (e: number, f: number, sx = 1, sy = sx, deg = 0): string =>
  `matrix(${r2(C * sx)} ${r2(H * sx)} ${r2(-C * sy)} ${r2(H * sy)} ${r2(e)} ${r2(f)})${deg ? ` rotate(${r2(deg)})` : ""}`;
/** Floor plane with u along +y (v along +x). */
const floorY = (e: number, f: number): string => `matrix(${r2(-C)} ${r2(H)} ${r2(C)} ${r2(H)} ${r2(e)} ${r2(f)})`;
/** Shape standing in the x/z plane (looks toward +y, the lit side): u -> +x, v -> up. */
const wallXZ = (e: number, f: number, s = 1, deg = 0): string => `matrix(${r2(C * s)} ${r2(H * s)} 0 ${r2(-U * s)} ${r2(e)} ${r2(f)})${deg ? ` rotate(${r2(deg)})` : ""}`;
/** Shape standing in the y/z plane (looks toward +x): u -> +y, v -> up. */
const wallYZ = (e: number, f: number): string => `matrix(${r2(-C)} ${r2(H)} 0 ${r2(-U)} ${r2(e)} ${r2(f)})`;
const billboard = (e: number, f: number, s: number): string => `translate(${r2(e)} ${r2(f)}) scale(${r2(s)})`;

const P = (d: string, cls: string, tf: string, o = 1, dr?: number): Prim => (dr === undefined ? { d, cls, tf, o } : { d, cls, tf, o, dr });

// shape cache: path strings never change per key, only transforms do
const cache = new Map<string, string>();
const memo = (key: string, make: () => string): string => {
  let v = cache.get(key);
  if (v === undefined) { v = make(); cache.set(key, v); }
  return v;
};
const faceCache = new Map<string, { d: string; cls: string }[]>();

const rect = (w: number, d: number): string => memo(`rect${w}x${d}`, () => `M${-w / 2} ${-d / 2}h${w}v${d}h${-w}Z`);
const CIRCLE = "M1 0A1 1 0 1 1 -1 0A1 1 0 1 1 1 0Z";

/** A solid (built around the origin) turned into one path per tone; all of them move with one transform. */
function solid(key: string, make: () => Face[], tf: string, o: number, out: Prim[]): void {
  let g = faceCache.get(key);
  if (!g) {
    const by = new Map<string, string>();
    for (const fc of make()) by.set(fc.tone, (by.get(fc.tone) ?? "") + fc.d);
    g = [...by].map(([tone, d]) => ({ d, cls: `f t-${tone}` }));
    faceCache.set(key, g);
  }
  for (const s of g) out.push(P(s.d, s.cls, tf, o));
}

// ------------------------------------------------------------------ the light pool under a station

function pad(c: Ctx, o: number, out: Prim[]): void {
  if (o <= 0.01) return;
  const [e, f] = W(c, 0, 0, c.gz);
  out.push(P(rect(6.6, 5.6), "a-fl", floor(e, f), o));
}

// ------------------------------------------------------------------ gestures

type Draw = (p: number, c: Ctx, out: Prim[], still: boolean, n: number) => void;

const GEAR = memo("gear12", () => {
  const T = 12;
  let d = "";
  for (let i = 0; i < T; i++) {
    const a = (i / T) * Math.PI * 2, w = Math.PI / T;
    for (const [da, rr] of [[-0.9, 0.8], [-0.4, 1], [0.4, 1], [0.9, 0.8]] as const) d += `${d ? "L" : "M"}${r2(Math.cos(a + da * w) * rr)} ${r2(Math.sin(a + da * w) * rr)}`;
  }
  return d + "Z";
});

/** read: a sheet slides in from the infeed side, lands on the item and fades. */
const drawRead: Draw = (p, c, out, still) => {
  const s = eo(seg(p, 0, 0.52));
  const fade = 1 - eio(seg(p, 0.74, 1));
  const bounce = Math.sin(Math.PI * seg(p, 0.52, 0.68)) * 0.4;
  const x = -10 * (1 - s), y = -1.7 * (1 - s), z = c.ht + 0.14 + 3.6 * (1 - s) * (1 - s) + bounce;
  const [e, f] = W(c, x, y, z);
  const deg = 38 * (1 - s);
  pad(c, still ? 0.24 : 0.26 * Math.sin(Math.PI * p), out);
  const [se, sf] = W(c, x, y, c.gz);
  out.push(P(rect(4.6, 3.3), "a-fd", floor(se, sf, 1, 1, deg), 0.34 * fade));
  if (!still && s < 0.95) out.push(P("M-3 -1.1H-7M-2.6 0.1H-8.4M-3 1.2H-6.2", "a-ln", floor(e, f), (1 - s) * 0.8));
  out.push(P(rect(4.6, 3.3), "f t-top", floor(e, f, 1, 1, deg), fade));
  out.push(P("M-1.8 -1.05H1.6M-1.8 -0.4H1M-1.8 0.25H1.4M-1.8 0.9H0.4", "a-lnd", floor(e, f, 1, 1, deg), 0.85 * fade));
  out.push(P("M1.4 -1.65L2.3 -1.65L2.3 -0.75Z", "f t-s1", floor(e, f, 1, 1, deg), fade));
  const land = seg(p, 0.5, 0.86);
  if (land > 0 && land < 1) {
    const [le, lf] = W(c, 0, 0, c.ht + 0.04);
    out.push(P(CIRCLE, "a-ln", floor(le, lf, lerp(1.4, 4.8, eo(land))), 0.9 * (1 - land)));
  }
};

const SPK = [[0.3, 3.0, 3.4], [1.1, 2.4, 4.4], [1.9, 3.6, 2.8], [2.6, 2.8, 4.0], [3.5, 3.3, 3.2], [4.2, 2.2, 4.8], [5.0, 3.0, 3.6], [5.7, 2.6, 3.0]] as const;
const HEAD = (): Face[] => box(-1.35, -1.35, 0, 2.7, 2.7, 1.1, { top: "top", left: "s1", right: "s2" });
const SHAFT = (): Face[] => box(-0.4, -0.4, 1.1, 0.8, 0.8, 4.4, { top: "s1", left: "s2", right: "s3" });

/** edit / write: the ram drops on the item's top face, recoils, leaves a stamped mark and sparks. */
const drawStrike: Draw = (p, c, out, still) => {
  const fall = ei(seg(p, 0, 0.3));
  const rec = eo(seg(p, 0.34, 0.52));
  const back = eio(seg(p, 0.7, 1));
  const h = still ? 0.05 : p < 0.34 ? lerp(5.0, 0.05, fall) : p < 0.7 ? lerp(0.05, 1.4, rec) : lerp(1.4, 5.0, back);
  const hit = p >= 0.3;
  const tau = seg(p, 0.3, 1);
  pad(c, still ? 0.24 : hit ? 0.3 * (1 - tau) + 0.05 : (0.1 * p) / 0.3, out);
  const [re, rf] = W(c, 0, 0, c.ht + 0.03); // the contact point: the item's top face
  if (hit) {
    const fadeM = still ? 1 : 1 - eio(seg(p, 0.78, 1));
    out.push(P(CIRCLE, "a-ln", floor(re, rf, lerp(1.3, 5.2, eo(tau))), 0.95 * (1 - tau)));
    out.push(P(rect(2.3, 1.5), "a-fd", floor(re, rf), fadeM * 0.9));
    out.push(P("M-0.9 -0.5H0.9V0.5H-0.9ZM-0.4 -0.2L0.4 0.2M-0.4 0.2L0.4 -0.2", "a-ln", floor(re, rf), fadeM));
  }
  const [he, hf] = W(c, 0, 0, c.ht + h);
  solid("strike.shaft", SHAFT, tl(he, hf), 1, out);
  solid("strike.head", HEAD, tl(he, hf), 1, out);
  if (hit && !still) {
    for (const [a, v, vz] of SPK) {
      const x = Math.cos(a) * v * tau * 0.95, y = Math.sin(a) * v * tau * 0.95;
      const [e, f] = W(c, x, y, c.ht + 0.3 + vz * tau - 7 * tau * tau);
      out.push(P(CIRCLE, "a-fl", billboard(e, f, 1.9 * (1 - 0.55 * tau)), Math.pow(1 - tau, 0.7)));
    }
  } else if (still) {
    for (let i = 0; i < 4; i++) {
      const [e, f] = W(c, Math.cos(SPK[i][0]) * 1.6, Math.sin(SPK[i][0]) * 1.6, c.ht + 1.2);
      out.push(P(CIRCLE, "a-fl", billboard(e, f, 1.8), 1));
    }
  }
};

const BUB = [[-0.9, -0.7, 0], [0.6, -0.9, 0.08], [-0.2, 0.2, 0.15], [0.9, 0.5, 0.05], [-0.8, 0.8, 0.22], [0.3, -0.2, 0.3], [0.1, 0.9, 0.12], [-0.5, -0.1, 0.26], [0.8, -0.3, 0.34], [-0.1, 0.6, 0.4]] as const;

/** bash test: the quench bath boils, bubbles burst, steam puffs. */
const drawTest: Draw = (p, c, out, still) => {
  const e = still ? 1 : Math.pow(Math.sin(Math.PI * p), 0.7);
  pad(c, still ? 0.24 : 0.22 * e, out);
  const [we, wf] = W(c, 0, 0, 0.02);
  out.push(P(rect(2.9, 2.9), "a-fl", floor(we, wf), 0.55 * e * (still ? 1 : 0.65 + 0.35 * Math.sin(p * 46))));
  if (!still) for (let i = 0; i < 2; i++) out.push(P(CIRCLE, "a-ln", floor(we, wf, lerp(0.5, 1.9, fr(p * 2.2 + i * 0.5))), 0.8 * (1 - fr(p * 2.2 + i * 0.5)) * e));
  for (let i = 0; i < BUB.length; i++) {
    const [bx, by, d] = BUB[i];
    const life = seg(p, d, d + 0.5);
    if (!still && (life <= 0 || life >= 1)) continue;
    const q = still ? 0.45 : life;
    const [be, bf] = W(c, bx + Math.sin(q * 9 + i) * 0.2, by, 0.2 + 3.4 * eo(q));
    out.push(P(CIRCLE, i % 2 ? "a-bub" : "a-ln", billboard(be, bf, 3.4 + (i % 3) * 1.1 + q * 1.8), 1 - Math.pow(q, 3) * 0.9));
  }
  for (let i = 0; i < 3; i++) {
    const q = still ? 0.5 : seg(p, 0.12 + i * 0.14, 0.78 + i * 0.1);
    if (!still && (q <= 0 || q >= 1)) continue;
    const [se, sf] = W(c, (i - 1) * 0.9, i % 2 ? 0.4 : -0.4, 1.2 + 4.8 * eo(q));
    out.push(P(CIRCLE, "a-fl", billboard(se, sf, 9 + 12 * q), 0.4 * Math.sin(Math.PI * q) + 0.04));
  }
};

const FLY_STACK = (): Face[] => box(-0.32, -0.32, 0, 0.64, 0.64, 1.7, { top: "s1", left: "s2", right: "s3" });

/** bash build: the flywheel spins up behind the item and the stack breathes out. */
const drawBuild: Draw = (p, c, out, still) => {
  const grow = still ? 1 : eo(seg(p, 0, 0.16)) * (1 - ei(seg(p, 0.86, 1)));
  const spin = still ? 20 : 820 * eio(p);
  pad(c, still ? 0.24 : 0.24 * Math.sin(Math.PI * p), out);
  const [ge, gf] = W(c, -2.3, -3.1, c.ht + 2.6);
  if (grow > 0.01) {
    out.push(P(CIRCLE, "a-wave", wallXZ(ge, gf, 2.9 * grow), 0.8 * grow));
    out.push(P(GEAR, "f t-s1", wallXZ(ge, gf, 2.5 * grow, spin), grow));
    out.push(P("M-0.78 0H0.78M0 -0.78V0.78M-0.55 -0.55L0.55 0.55M-0.55 0.55L0.55 -0.55", "a-lnd", wallXZ(ge, gf, 2.5 * grow, spin), 0.9 * grow));
    out.push(P(CIRCLE, "f t-s3", wallXZ(ge, gf, 0.62 * grow), grow));
  }
  const [se, sf] = W(c, 2.4, -3.0, c.ht + 0.1);
  solid("build.stack", FLY_STACK, `translate(${r2(se)} ${r2(sf)}) scale(1 ${r2(Math.max(0.01, grow))})`, 1, out);
  for (let i = 0; i < 3; i++) {
    const q = still ? 0.5 : seg(p, 0.1 + i * 0.2, 0.62 + i * 0.2);
    if (!still && (q <= 0 || q >= 1)) continue;
    const [pe, pf] = W(c, 2.4 + q * 1.2, -3.0, c.ht + 1.9 + 3.6 * eo(q));
    out.push(P(CIRCLE, "a-fl", billboard(pe, pf, 5 + 10 * q), 0.42 * Math.sin(Math.PI * q) + 0.03));
  }
};

const PUMP_HOUSE = (): Face[] => box(2.0, -1.0, 0, 1.7, 1.7, 3.0, { top: "s1", left: "s2", right: "s3" });
const PUMP_ROD = (): Face[] => box(2.55, -0.45, 3.0, 0.6, 0.6, 2.6, { top: "top", left: "s1", right: "s2" });
const PUMP_CAP = (): Face[] => box(2.2, -0.8, 5.5, 1.3, 1.3, 0.5, { top: "top", left: "s1", right: "s2" });

/** other bash: a small piston at the station pumps twice. */
const drawPump: Draw = (p, c, out, still) => {
  const w = still ? 0.25 : seg(p, 0.08, 0.92);
  const stroke = 0.5 - 0.5 * Math.cos(w * Math.PI * 4); // two pumps
  pad(c, still ? 0.24 : 0.2 * Math.sin(Math.PI * p) + 0.06 * stroke, out);
  const [be, bf] = W(c, 0, 0, c.ht);
  solid("pump.house", PUMP_HOUSE, tl(be, bf), 1, out);
  const [re, rf] = W(c, 0, 0, c.ht - 2.0 * stroke);
  solid("pump.rod", PUMP_ROD, tl(re, rf), 1, out);
  solid("pump.cap", PUMP_CAP, tl(re, rf), 1, out);
  for (let i = 0; i < 2; i++) {
    const q = still ? (i ? 9 : 0.5) : seg(p, 0.2 + i * 0.36, 0.62 + i * 0.36);
    if (q >= 1 || q <= 0) continue;
    const [pe, pf] = W(c, 3.3 + q * 0.9, -0.2, c.ht + 1.0 + 1.8 * eo(q));
    out.push(P(CIRCLE, "a-fl", billboard(pe, pf, 4.5 + 8 * q), 0.4 * (1 - q)));
    const [ie, iff] = W(c, 0, 0, c.ht + 0.03);
    out.push(P(CIRCLE, "a-ln", floor(ie, iff, lerp(1.2, 3.6, eo(q))), 0.8 * (1 - q)));
  }
};

/** grep / glob / list: a thin lit plane sweeps over the item and back. */
const drawScan: Draw = (p, c, out, still) => {
  const fwd = p < 0.5;
  const q = still ? 0.5 : fwd ? eio(p / 0.5) : 1 - eio((p - 0.5) / 0.5);
  const x = lerp(-c.hx - 1.5, c.hx + 1.5, q);
  const ends = still ? 1 : seg(p, 0, 0.1) * (1 - seg(p, 0.9, 1));
  pad(c, still ? 0.24 : 0.2 * Math.sin(Math.PI * p), out);
  const w = c.hy + 1.5, hgt = c.ht + 2.8;
  const [be, bf] = W(c, x, 0, 0);
  const [ge, gf] = W(c, x + (still ? 0 : fwd ? -1.1 : 1.1), 0, 0);
  const body = `M${-w} 0H${w}V${hgt}H${-w}Z`;
  out.push(P(body, "a-fl", wallYZ(ge, gf), 0.1 * ends));
  out.push(P(body, "a-fl", wallYZ(be, bf), 0.3 * ends));
  out.push(P(body, "a-ln", wallYZ(be, bf), 0.95 * ends));
  const [le, lf] = W(c, x, 0, c.ht + 0.04);
  out.push(P(`M${-w} 0H${w}`, "a-ln2", floorY(le, lf), ends));
};

const DRONE_BODY = (): Face[] => box(-0.75, -0.75, 0, 1.5, 1.5, 0.5, { top: "top", left: "s1", right: "s2" });
const dronePos = (p: number, c: Ctx): [number, number, number] => {
  const out = eo(seg(p, 0, 0.3)), back = eio(seg(p, 0.7, 1));
  const k = out * (1 - back);
  const wob = seg(p, 0.3, 0.7);
  return [lerp(0, 4.6, k) + Math.sin(wob * 9) * 0.35 * k, lerp(0, -3.4, k) + Math.cos(wob * 7) * 0.3 * k, c.ht + 0.5 + 4.4 * k + Math.sin(wob * 11) * 0.2 * k];
};
const DOT4 = (r: number): string => {
  const a = 1.9;
  let d = "";
  for (const [cx, cy] of [[-a, -a], [a, a], [-a, a], [a, -a]] as const) d += `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  return d;
};

/** task: a drone detaches from the station, hovers and comes back. */
const drawDrone: Draw = (p, c, out, still) => {
  const [x, y, z] = still ? [4.2, -3.1, c.ht + 4.5] : dronePos(p, c);
  const [de, df] = W(c, x, y, z);
  const [e0, f0] = W(c, 0, 0, c.ht + 0.5);
  pad(c, still ? 0.24 : 0.2 * Math.sin(Math.PI * p), out);
  const lift = still ? 1 : Math.sin(Math.PI * p);
  const [ce, cf] = W(c, 0, 0, c.ht + 0.04);
  out.push(P(CIRCLE, "a-ln", floor(ce, cf, 1.7 + 0.5 * Math.sin(p * 12)), 0.9 * Math.min(1, lift * 2)));
  const [se, sf] = W(c, x, y, c.gz);
  out.push(P(CIRCLE, "a-fd", floor(se, sf, 1.2 + (z - c.ht) * 0.12, 0.8 + (z - c.ht) * 0.1), 0.3));
  out.push(P(`M${r2(e0 - de)} ${r2(f0 - df)}L0 0`, "a-dash", tl(de, df), 0.8));
  solid("drone.body", DRONE_BODY, tl(de, df), 1, out);
  const [fe, ff] = W(c, x, y, z + 0.5);
  out.push(P("M-1.9 -1.9L1.9 1.9M-1.9 1.9L1.9 -1.9", "a-lnd", floor(fe, ff), 1));
  out.push(P(memo("dot4", () => DOT4(0.75)), "a-fl", floor(fe, ff), 0.34));
  const a = still ? 0.4 : (p * 70) % Math.PI;
  let bl = "";
  for (const [cx, cy] of [[-1.9, -1.9], [1.9, 1.9], [-1.9, 1.9], [1.9, -1.9]] as const) bl += `M${r2(cx + Math.cos(a) * 0.95)} ${r2(cy + Math.sin(a) * 0.95)}L${r2(cx - Math.cos(a) * 0.95)} ${r2(cy - Math.sin(a) * 0.95)}`;
  out.push(P(bl, "a-ln", floor(fe, ff), 1));
};

const MASTB = (): Face[] => box(-0.18, -0.18, 0, 0.36, 0.36, 4.6, { top: "top", left: "s1", right: "s2" });
const MAST_FOOT = (): Face[] => box(-0.7, -0.7, 0, 1.4, 1.4, 0.35, { top: "s1", left: "s2", right: "s3" });

/** webfetch: an antenna rises beside the item and pulses rings. */
const drawAntenna: Draw = (p, c, out, still) => {
  const grow = still ? 1 : eo(seg(p, 0, 0.18)) * (1 - eio(seg(p, 0.88, 1)));
  pad(c, still ? 0.24 : 0.2 * Math.sin(Math.PI * p), out);
  const mx = -2.6, my = -2.2, bz = c.ht - 0.4;
  const [me, mf] = W(c, mx, my, bz);
  solid("ant.foot", MAST_FOOT, tl(me, mf), Math.min(1, grow * 3), out);
  if (grow > 0.02) solid("ant.mast", MASTB, `translate(${r2(me)} ${r2(mf)}) scale(1 ${r2(grow)})`, 1, out);
  const [te, tf] = W(c, mx, my, bz + 4.6 * grow);
  out.push(P(CIRCLE, "a-fl", billboard(te, tf - 2, 2.6), grow));
  const [re, rf] = W(c, mx, my, bz + 4.6);
  for (let i = 0; i < 3; i++) {
    const q = still ? 0.2 + i * 0.3 : seg(p, 0.16 + i * 0.17, 0.62 + i * 0.17);
    if (!still && (q <= 0 || q >= 1)) continue;
    out.push(P(CIRCLE, "a-wave", floor(re, rf, lerp(0.6, 5.4, eo(q))), 0.95 * (1 - q)));
  }
};

/** text: an ink ripple spreads on the station and a line of notes writes itself on the item. */
const drawInk: Draw = (p, c, out, still) => {
  pad(c, still ? 0.24 : 0.2 * Math.sin(Math.PI * p), out);
  const [e, f] = W(c, 0, 0, c.ht + 0.04);
  for (let i = 0; i < 3; i++) {
    const q = still ? 0.25 + i * 0.3 : seg(p, i * 0.14, 0.7 + i * 0.1);
    if (!still && (q <= 0 || q >= 1)) continue;
    out.push(P(CIRCLE, "a-wave", floor(e, f, lerp(0.8, 4.6, eo(q))), 0.9 * (1 - q)));
  }
  const wr = still ? 0.7 : eo(seg(p, 0.05, 0.7));
  out.push(P("M-1.5 0.3C-1.2 -0.6-0.8 0.6-0.5-0.2S0.1 0.5 0.4-0.1S1 0.4 1.5-0.3", "a-ink", floor(e, f), 1 - eio(seg(p, 0.8, 1)), wr));
  for (let i = 0; i < 3; i++) {
    const q = still ? 0.4 : seg(p, 0.08 + i * 0.1, 0.55 + i * 0.1);
    if (!still && (q <= 0 || q >= 1)) continue;
    const a = 1 + i * 2.1;
    const [de, df] = W(c, Math.cos(a) * 1.4 * q, Math.sin(a) * 1.4 * q, c.ht + 0.2 + 1.8 * Math.sin(Math.PI * q));
    out.push(P(CIRCLE, "a-fl", billboard(de, df, 1.7), 1 - q));
  }
};

/** step: one tick on the station's progress ring, nothing else. */
const drawTick: Draw = (p, c, out, _still, n) => {
  const a = -Math.PI * 0.75 + (n % 8) * 0.55;
  const [e, f] = W(c, 0, 0, c.rz);
  const o = 1 - eio(seg(p, 0.3, 1));
  const r1 = 2.55 + 0.25 * (1 - eo(seg(p, 0, 0.25)));
  out.push(P(`M${r2(Math.cos(a) * r1)} ${r2(Math.sin(a) * r1)}L${r2(Math.cos(a) * 3.55)} ${r2(Math.sin(a) * 3.55)}`, "a-tick", floor(e, f), o));
  const [de, df] = W(c, Math.cos(a) * 3.05, Math.sin(a) * 3.05, c.rz);
  out.push(P(CIRCLE, "a-fl", billboard(de, df, 1.6), o));
};

/** The jagged outline that follows a failed tool: a shape change, not a colour change. */
function jag(p: number, c: Ctx, out: Prim[]): void {
  const fp = seg(p, 0.64, 1);
  const on = Math.floor(fp * 9) % 2 === 0 ? 1 : 0.18;
  const [e, f] = W(c, 0, 0, c.ht + 0.05);
  const d = memo(`jag${c.hx}x${c.hy}`, () => {
    const a = c.hx + 0.55, b = c.hy + 0.55;
    const pts: [number, number][] = [];
    const edge = (x0: number, y0: number, x1: number, y1: number): void => {
      const n = Math.max(4, Math.round(Math.hypot(x1 - x0, y1 - y0) / 0.5));
      const nx = -(y1 - y0), ny = x1 - x0, l = Math.hypot(nx, ny) || 1;
      for (let i = 0; i < n; i++) {
        const t = i / n, s = (i % 2 ? 1 : -1) * 0.26;
        pts.push([x0 + (x1 - x0) * t + (nx / l) * s, y0 + (y1 - y0) * t + (ny / l) * s]);
      }
    };
    edge(-a, -b, a, -b); edge(a, -b, a, b); edge(a, b, -a, b); edge(-a, b, -a, -b);
    return "M" + pts.map((q) => `${r2(q[0])} ${r2(q[1])}`).join("L") + "Z";
  });
  out.push(P(d, "a-jag", floor(e, f), on * (1 - fp * 0.4)));
  out.push(P("M-1.1 -0.5L-0.3 0.1L-0.7 0.5L0.2 0.8M0.6 -0.7L0.2 -0.1L0.9 0.3", "a-lnd", floor(e, f), on));
}

const DRAWS: Record<ActionKind, Draw> = {
  read: drawRead, strike: drawStrike, test: drawTest, build: drawBuild, pump: drawPump, scan: drawScan, drone: drawDrone, antenna: drawAntenna, ink: drawInk, tick: drawTick,
};
/** The progress at which a gesture is most legible: what reduced-motion shows, frozen. */
export const STILL_P: Record<ActionKind, number> = { read: 0.62, strike: 0.38, test: 0.5, build: 0.5, pump: 0.3, scan: 0.5, drone: 0.5, antenna: 0.5, ink: 0.5, tick: 0.3 };

/** Append the primitives of one gesture at progress `p` (0..1). `still` draws the frozen pose. */
export function draw(kind: ActionKind, p: number, c: Ctx, error: boolean, n: number, still: boolean, out: Prim[]): void {
  // errors: the gesture plays in the first 70 % of its time, the jagged flicker closes it
  const bp = error && !still ? clamp01(p / 0.7) : clamp01(p);
  DRAWS[kind](bp, c, out, still, n);
  if (error && kind !== "tick" && (still || p > 0.64)) jag(still ? 0.7 : p, c, out);
}

/** Pose of a gesture frozen in place (prefers-reduced-motion lights the parts instead of moving them). */
export function stillPrims(kind: ActionKind, error: boolean, c: Ctx): Prim[] {
  const out: Prim[] = [];
  draw(kind, STILL_P[kind], c, error, 0, true, out);
  return out.filter((q) => q.o > 0.01);
}
