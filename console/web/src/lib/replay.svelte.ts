// Replay: a finished run is played back on its own lane by feeding the same store path the SSE uses.
// The pure half (normalise, frameAt, advance) has no store and no clock, so it is unit-tested; the
// Replayer class below is the thin stateful shell around it.
import { STAGES } from "./types";
import type { Item, Slot, Stage } from "./types";
import { emptySlot } from "./reduce";
import { request } from "./api";
import { store, ui } from "./store.svelte";

export const SPEEDS = [1, 10, 30, 60] as const;
export const DEFAULT_SPEED = 30;
const TURN_TAIL_MS = 4000;

export interface RunSummary {
  id: string; issue: number; tag: string | null; title: string; slot: number;
  started: number; ended: number; outcome: string | null; turns: string[]; items: number;
}
export interface RItem extends Item { phase?: string }
export interface Detail {
  id: string; issue: number; tag: string | null; title: string; slot: number; outcome: string | null; url: string | null;
  /** epoch ms */ t0: number; t1: number;
  items: RItem[];
  timeline: { t: number; stage: Stage }[];
}

const isStage = (v: unknown): v is Stage => typeof v === "string" && (STAGES as readonly string[]).includes(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Repairs a GET /api/replay/:id payload; null when it is not a run at all. */
export function normalizeDetail(raw: unknown): Detail | null {
  if (!isObj(raw) || typeof raw.id !== "string") return null;
  const items: RItem[] = [];
  if (Array.isArray(raw.items)) {
    for (const x of raw.items) {
      if (!isObj(x) || !finite(x.t)) continue;
      if (x.kind !== "tool" && x.kind !== "text" && x.kind !== "step" && x.kind !== "error") continue;
      const tk = isObj(x.tokens) && finite(x.tokens.in) && finite(x.tokens.out) ? { in: x.tokens.in, out: x.tokens.out } : null;
      items.push({ t: x.t, kind: x.kind, tool: str(x.tool), target: str(x.target), text: str(x.text), status: str(x.status), tokens: tk, phase: str(x.phase) ?? undefined });
    }
  }
  items.sort((a, b) => a.t - b.t);
  const timeline: Detail["timeline"] = [];
  if (Array.isArray(raw.timeline)) for (const x of raw.timeline) if (isObj(x) && finite(x.t) && isStage(x.stage)) timeline.push({ t: x.t, stage: x.stage });
  timeline.sort((a, b) => a.t - b.t);
  const starts = [finite(raw.started) ? raw.started * 1000 : Infinity, timeline[0]?.t ?? Infinity, items[0]?.t ?? Infinity];
  const ends = [finite(raw.ended) ? raw.ended * 1000 : -Infinity, timeline.at(-1)?.t ?? -Infinity, items.at(-1)?.t ?? -Infinity];
  const t0 = Math.min(...starts), t1 = Math.max(...ends);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  const slot = finite(raw.slot) && raw.slot >= 1 && raw.slot <= 3 ? Math.floor(raw.slot) : (/-s([1-3])$/.exec(raw.id)?.[1] ? Number(/-s([1-3])$/.exec(raw.id)![1]) : 1);
  return {
    id: raw.id, issue: finite(raw.issue) ? raw.issue : 0, tag: str(raw.tag), title: str(raw.title) ?? `issue #${finite(raw.issue) ? raw.issue : "?"}`,
    slot, outcome: str(raw.outcome), url: str(raw.url), t0, t1: Math.max(t1, t0 + 1), items, timeline,
  };
}

/** Stage at absolute time t: the last timeline entry at or before t ("pick" before the first). */
export function stageAt(tl: Detail["timeline"], t: number): Stage {
  let s: Stage = tl[0]?.stage ?? "pick";
  for (const e of tl) { if (e.t <= t) s = e.stage; else break; }
  return s;
}

/** Items with a < t <= b (items sorted by t). */
export function itemsIn(items: RItem[], a: number, b: number): RItem[] {
  const out: RItem[] = [];
  for (const it of items) { if (it.t > b) break; if (it.t > a) out.push(it); }
  return out;
}

/** The model turn running at t: consecutive items of one phase form a window that lingers briefly after its last item. */
export function turnAt(items: RItem[], t: number): { phase: string; start: number } | null {
  let cur: { phase: string; start: number; last: number } | null = null;
  for (const it of items) {
    if (it.t > t) break;
    const ph = it.phase ?? "turn";
    if (cur && cur.phase === ph) cur.last = it.t;
    else cur = { phase: ph, start: it.t, last: it.t };
  }
  return cur && t - cur.last <= TURN_TAIL_MS ? { phase: cur.phase, start: cur.start } : null;
}

export interface Frame { slot: Slot; stage: Stage; key: string }

/** The slot object the lane components should see when the recording is at absolute time `t`. `nowS` is the live clock. */
export function frameAt(d: Detail, t: number, nowS: number): Frame {
  const stage = stageAt(d.timeline, t);
  const turn = turnAt(d.items, t);
  let tin = 0, tout = 0;
  for (const it of d.items) { if (it.t > t) break; if (it.kind === "step" && it.tokens) { tin += it.tokens.in; tout += it.tokens.out; } }
  let stageStart = d.t0;
  for (const e of d.timeline) { if (e.t <= t) stageStart = e.t; else break; }
  const atPr = STAGES.indexOf(stage) >= STAGES.indexOf("pr");
  const slot: Slot = {
    ...emptySlot(d.slot),
    run_id: `replay-${d.id}`, state: "running", stage, sub: "",
    issue: { n: d.issue, title: d.title, tag: d.tag, family: d.tag ? d.tag.split("-")[0] : null, url: d.url ?? "" },
    pr: atPr && d.url ? { n: Number(/\/(\d+)$/.exec(d.url)?.[1] ?? 0), url: d.url, head: "" } : null,
    turn: turn ? { phase: turn.phase, started: Math.floor(nowS - (t - turn.start) / 1000), events: "replay" } : null,
    stage_started: Math.floor(nowS - (t - stageStart) / 1000),
    issue_started: Math.floor(nowS - (t - d.t0) / 1000),
    tokens: { input: tin, output: tout, cache_read: 0 },
    effective_agents: Math.max(1, d.slot), log_dir: "replay", updated: Math.floor(nowS),
  };
  return { slot, stage, key: `${stage}|${turn?.phase ?? ""}|${turn?.start ?? ""}` };
}

export interface Step { slot: Frame; items: RItem[]; reset: boolean }

/** What to emit when the recording moves from absolute time `from` to `to`. A backwards or very long jump resets the activity. */
export function advance(d: Detail, from: number, to: number, nowS: number, keep = 50): Step {
  const frame = frameAt(d, to, nowS);
  if (to < from || itemsIn(d.items, from, to).length > keep) {
    const upto = itemsIn(d.items, -Infinity, to);
    return { slot: frame, items: upto.slice(-keep), reset: true };
  }
  return { slot: frame, items: itemsIn(d.items, from, to), reset: false };
}

/** Real elapsed ms -> recorded ms. */
export const recordedDelta = (dtMs: number, speed: number): number => dtMs * speed;

/** Clamped playhead position as a fraction of the run, and stage segments as fractions (for the scrub bar). */
export function segments(d: Detail): { stage: Stage; a: number; b: number }[] {
  const span = d.t1 - d.t0;
  const tl = d.timeline.length ? d.timeline : [{ t: d.t0, stage: "pick" as Stage }];
  return tl.map((e, i) => ({ stage: e.stage, a: Math.max(0, (e.t - d.t0) / span), b: Math.min(1, ((tl[i + 1]?.t ?? d.t1) - d.t0) / span) })).filter((s) => s.b > s.a);
}


// ---------------------------------------------------------------- stateful shell
class Replayer {
  runs = $state.raw<RunSummary[] | null>(null);
  listError = $state<string | null>(null);
  detail = $state.raw<Detail | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  /** recorded ms since the start of the run */
  pos = $state(0);
  playing = $state(false);
  speed = $state(DEFAULT_SPEED);

  private last = 0; // absolute recorded ms already emitted
  private lastKey = "";
  private lastSlotAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickAt = 0;

  get duration(): number { return this.detail ? this.detail.t1 - this.detail.t0 : 0; }
  get stage(): Stage { return this.detail ? stageAt(this.detail.timeline, this.detail.t0 + this.pos) : "pick"; }

  async list(): Promise<void> {
    this.listError = null;
    const r = await request("GET", "/api/replay");
    const raw = r.data?.runs;
    if (!r.ok || !Array.isArray(raw)) { this.listError = r.status === 404 ? "replay is not available on this server" : "failed to load the run list"; this.runs = []; return; }
    this.runs = raw.filter((x): x is RunSummary => isObj(x) && typeof x.id === "string").map((x) => ({
      id: x.id, issue: Number(x.issue) || 0, tag: str(x.tag), title: str(x.title) ?? "", slot: Number(x.slot) || 1, started: Number(x.started) || 0,
      ended: Number(x.ended) || 0, outcome: str(x.outcome), turns: Array.isArray(x.turns) ? x.turns.map(String) : [], items: Number(x.items) || 0,
    }));
  }

  async load(id: string): Promise<void> {
    this.stop();
    this.loading = true; this.error = null;
    const r = await request("GET", `/api/replay/${encodeURIComponent(id)}`);
    const d = r.ok ? normalizeDetail(r.data) : null;
    this.loading = false;
    if (!d) { this.error = "run could not be loaded"; return; }
    this.detail = d;
    this.pos = 0;
    this.last = d.t0 - 1;
    this.lastKey = "";
    store.replayLane = d.slot;
    // blank the lane first so the issue "arrives" on the infeed like a live pick
    this.emit(0, true);
    this.play();
  }

  play(): void {
    if (!this.detail) return;
    if (this.pos >= this.duration) this.seek(0);
    this.playing = true;
    this.tickAt = performance.now();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 100);
  }
  pause(): void { this.playing = false; }
  toggle(): void { if (this.playing) this.pause(); else this.play(); }
  setSpeed(s: number): void { this.speed = s; }

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(500, now - this.tickAt);
    this.tickAt = now;
    if (!this.playing || !this.detail) return;
    this.moveTo(Math.min(this.duration, this.pos + recordedDelta(dt, this.speed)));
    if (this.pos >= this.duration) this.playing = false;
  }

  seek(rel: number): void {
    if (!this.detail) return;
    this.moveTo(Math.max(0, Math.min(this.duration, rel)));
  }

  private moveTo(rel: number): void {
    const d = this.detail;
    if (!d) return;
    this.pos = rel;
    this.emit(rel, false);
  }

  /** Feed the store exactly as an SSE connection would: one `slot` event, one `activity` event. */
  private emit(rel: number, first: boolean): void {
    const d = this.detail;
    if (!d) return;
    const to = d.t0 + rel;
    const st = advance(d, first ? to - 1 : this.last, to, store.nowF());
    const nowMs = Date.now();
    this.last = to;
    // re-stamp so "x s ago" in the components reads in live seconds, not recorded ones
    const stamped = st.items.map((it) => ({ ...it, t: Math.round(nowMs - (to - it.t) / this.speed) }));
    // activity first so the lane's reset/clear lands before the slot that references it
    if (first || st.reset || stamped.length) store.ingest("activity", { slot: d.slot, items: stamped, reset: first || st.reset });
    if (first || st.slot.key !== this.lastKey || nowMs - this.lastSlotAt > 1000) {
      this.lastKey = st.slot.key;
      this.lastSlotAt = nowMs;
      store.ingest("slot", st.slot.slot);
    }
  }

  /** Leave replay: drop the gate and make the live view exact again from /api/state. */
  async exit(): Promise<void> {
    this.stop();
    this.detail = null;
    store.replayLane = null;
    ui.replay = null;
    const r = await request("GET", "/api/state");
    if (r.ok && r.data) store.ingest("snapshot", r.data);
  }

  stop(): void {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
export const replayer = new Replayer();
