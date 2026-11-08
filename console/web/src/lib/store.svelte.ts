// One snapshot, one reducer, one clock. Everything the machine draws and every readout prints
// comes from `store.snap`, so motion and numbers cannot disagree.
import { sanitizeEvent } from "./sanitize";
import { apply, emptySnapshot, strokesIn } from "./reduce";
import type { Item, Snapshot } from "./types";

export type Auth = "unknown" | "ok" | "login";
export type Link = "connecting" | "live" | "poll" | "offline";
export type Theme = "dark" | "blueprint";

const THEME_KEY = "hc-theme";

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "dark" || v === "blueprint") return v;
  } catch { /* storage may be blocked */ }
  return "dark";
}

/** A fresh snapshot must not overwrite the lane that is being replayed: carry that lane's slot and activity over. */
export function holdLane(next: Snapshot, cur: Snapshot, lane: number): Snapshot {
  if (!(lane >= 1 && lane <= 3)) return next;
  const slots = next.slots.slice();
  slots[lane - 1] = cur.slots[lane - 1];
  return { ...next, slots, activity: { ...next.activity, [String(lane)]: cur.activity[String(lane)] ?? [] } };
}

/** True when a live stream event must be dropped because its lane is being replayed. */
export function heldByReplay(key: string, data: unknown, lane: number | null): boolean {
  if (lane == null || (key !== "slot" && key !== "activity")) return false;
  return typeof data === "object" && data !== null && (data as { slot?: unknown }).slot === lane;
}

class Store {
  snap = $state.raw<Snapshot>(emptySnapshot());
  ready = $state(false);
  auth = $state<Auth>("unknown");
  link = $state<Link>("connecting");
  theme = $state<Theme>(readTheme());
  /** Server-corrected wall clock in epoch seconds; ticks once per second. */
  now = $state(Math.floor(Date.now() / 1000));
  /** Press strokes seen per slot (index 0..2): one per new `tool` activity item. */
  strokes = $state.raw<number[]>([0, 0, 0]);
  /** Client-side arrival times (ms) of tool items per slot, for the activity rate. */
  arrivals: number[][] = [[], [], []];
  /** Client time (ms) of the last activity event of any kind per slot: "model thinking" = silence > 5 s. */
  lastEvent: number[] = [0, 0, 0];
  /** step tokens (in + out) with client arrival time, for the flywheel's tokens/min. */
  tokenLog: { t: number; n: number }[] = [];
  /** Replay gate: the 1-based slot whose live `slot`/`activity` updates are held while a recording plays on it (null = none). */
  replayLane = $state<number | null>(null);
  private offset = 0;

  constructor() {
    this.applyTheme();
  }

  ingest(key: string, raw: unknown): boolean {
    const clean = sanitizeEvent(key, raw, this.snap);
    if (!clean.ok) return false;
    let data = clean.value;
    if (key === "snapshot" && this.replayLane != null) data = holdLane(data as Snapshot, this.snap, this.replayLane);
    if (key === "snapshot") {
      this.offset = (data as Snapshot).now - Date.now() / 1000;
      this.ready = true;
      this.auth = "ok";
    } else if (key === "activity") {
      const a = data as { slot: number; items: Item[]; reset?: boolean };
      const k = a.slot - 1;
      if (k >= 0 && k < 3 && !a.reset) {
        const nowMs = Date.now();
        if (a.items.length) this.lastEvent[k] = nowMs;
        for (const it of a.items) if (it.kind === "step" && it.tokens) this.tokenLog.push({ t: nowMs, n: it.tokens.in + it.tokens.out });
        if (this.tokenLog.length > 300) this.tokenLog.splice(0, this.tokenLog.length - 300);
        const n = strokesIn(a.items);
        if (n > 0) {
          const next = this.strokes.slice();
          next[k] += n;
          this.strokes = next;
          const t = Date.now();
          this.arrivals[k].push(...Array.from({ length: n }, () => t));
          if (this.arrivals[k].length > 400) this.arrivals[k].splice(0, this.arrivals[k].length - 400);
        }
      }
    }
    this.snap = apply(this.snap, key, data);
    if (key === "snapshot") this.tick();
    return true;
  }

  tick(): void {
    this.now = Math.floor(Date.now() / 1000 + this.offset);
  }

  /** Server-corrected wall clock in seconds, continuous (not floored): for rings and lifts that move every frame. */
  nowF(): number {
    return Date.now() / 1000 + this.offset;
  }

  /** Tool items per second over the last `windowMs` for a slot (index 0..2). */
  rate(k: number, nowMs = Date.now(), windowMs = 12_000): number {
    const a = this.arrivals[k];
    let n = 0;
    for (let i = a.length - 1; i >= 0 && nowMs - a[i] <= windowMs; i--) n++;
    return n / (windowMs / 1000);
  }

  /** Model tokens per minute across all lanes over the last 60 s. */
  tokensPerMin(nowMs = Date.now()): number {
    let n = 0;
    for (let i = this.tokenLog.length - 1; i >= 0 && nowMs - this.tokenLog[i].t <= 60_000; i--) n += this.tokenLog[i].n;
    return n;
  }

  /** A turn is running but nothing has arrived for more than 5 s. */
  thinking(k: number, nowMs = Date.now()): boolean {
    const s = this.snap.slots[k];
    return s.turn != null && nowMs - this.lastEvent[k] > 5000;
  }

  setTheme(t: Theme): void {
    this.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
    this.applyTheme();
  }

  private applyTheme(): void {
    if (typeof document !== "undefined") document.documentElement.dataset.theme = this.theme;
  }
}

export const store = new Store();

/** Transient UI state: which sheet is open, which lane is highlighted. */
class Ui {
  boardOpen = $state(false);
  deckOpen = $state(false);
  sheet = $state<null | { kind: "stop"; k: number } | { kind: "steer"; k: number } | { kind: "issue"; n: number }>(null);
  hoverLane = $state<number | null>(null);
  /** lane whose readout is flashed after a fly-to (double-click on a station) */
  focusLane = $state<number | null>(null);
  private focusTimer: ReturnType<typeof setTimeout> | undefined;
  lane = $state(0); // mobile: which lane is in view
  toast = $state<string | null>(null);
  pendingAgents = $state<number | null>(null);
  /** inspect drawer: lane and the station that was clicked (SCHEMA 6.1) */
  inspect = $state<null | { k: number; stage: string | null }>(null);
  /** replay mode: null = off; id null = the run picker, else the log-dir id being replayed (SCHEMA 6.2) */
  replay = $state<null | { id: string | null }>(null);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  flash(k: number): void {
    this.focusLane = k;
    clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => (this.focusLane = null), 2600);
  }

  say(msg: string): void {
    this.toast = msg;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), 4200);
  }
}
export const ui = new Ui();
