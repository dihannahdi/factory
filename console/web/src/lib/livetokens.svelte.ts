// Live token counts. slot.tokens is only summed by the orchestrator at the end of a turn, so while a
// model turn runs the machine would read "in 0 out 0". The activity stream has a `step` item per
// model step with its tokens: we add those on top, deduped by their timestamp, and start over when
// the turn or run changes.
//
// All bookkeeping here is plain (non-reactive) data, mutated idempotently while a $derived reads
// it. Nothing writes $state, so no $effect can ever loop on it.
import { store } from "./store.svelte";
import type { Item, Slot, Tokens } from "./types";

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export interface Acc {
  key: string; // run + turn identity; a different key resets the sums
  started: number; // turn start, epoch ms
  seen: Set<number>; // step timestamps already counted into the sums
  input: number;
  output: number;
  src: readonly Item[] | null; // the activity array last fed (skip when unchanged)
  log: { t: number; n: number }[]; // recent steps for tokens/min, newest last, kept ~2 min
  logSeen: Set<number>;
}

export const newAcc = (): Acc => ({ key: "", started: 0, seen: new Set(), input: 0, output: 0, src: null, log: [], logSeen: new Set() });

export const LOG_KEEP_MS = 120_000;

/** Identity of the turn a lane is in; null when no turn runs. */
export function turnKey(slot: Pick<Slot, "run_id" | "turn">): string {
  return slot.turn ? `${slot.run_id ?? ""}|${slot.turn.events}|${slot.turn.started}` : "";
}

/**
 * Feed one lane's activity items. Steps at or after `startedMs` add to the turn sums (once per `t`);
 * every step, whichever turn, goes to the tokens/min log (once per `t`, newer than `nowMs - 2 min`).
 */
export function accumulate(acc: Acc, key: string, startedMs: number, items: readonly Item[], nowMs: number): void {
  if (key !== acc.key) {
    acc.key = key;
    acc.started = startedMs;
    acc.seen.clear();
    acc.input = 0;
    acc.output = 0;
    acc.src = null;
  }
  if (items !== acc.src) {
    acc.src = items;
    for (const it of items) {
      if (it.kind !== "step" || !it.tokens) continue;
      const n = it.tokens.in + it.tokens.out;
      if (key && it.t >= startedMs && !acc.seen.has(it.t)) {
        acc.seen.add(it.t);
        acc.input += it.tokens.in;
        acc.output += it.tokens.out;
      }
      if (!acc.logSeen.has(it.t) && nowMs - it.t <= LOG_KEEP_MS) {
        acc.logSeen.add(it.t);
        acc.log.push({ t: it.t, n });
      }
    }
    acc.log.sort((a, b) => a.t - b.t);
  }
  // prune the log (and its dedupe set) so a long session does not grow without bound
  let cut = 0;
  while (cut < acc.log.length && nowMs - acc.log[cut].t > LOG_KEEP_MS) { acc.logSeen.delete(acc.log[cut].t); cut++; }
  if (cut) acc.log.splice(0, cut);
}

/** slot.tokens (summed at turn end) plus the steps of the turn that is running now. */
export function liveOf(base: Tokens | null, acc: Pick<Acc, "input" | "output">): { input: number; output: number } {
  return { input: (base?.input ?? 0) + acc.input, output: (base?.output ?? 0) + acc.output };
}

/** Tokens across `acc.log` entries within the last `windowMs`. */
export function sumWindow(accs: readonly Pick<Acc, "log">[], nowMs: number, windowMs = 60_000): number {
  let n = 0;
  for (const a of accs) for (let i = a.log.length - 1; i >= 0 && nowMs - a.log[i].t <= windowMs; i--) n += a.log[i].n;
  return n;
}

const accs: Acc[] = [newAcc(), newAcc(), newAcc()];

function feed(k: number): Acc {
  const slot = store.snap.slots[k];
  const items = store.snap.activity[String(k + 1)] ?? [];
  accumulate(accs[k], turnKey(slot), slot.turn ? slot.turn.started * 1000 : 0, items, store.nowF() * 1000);
  return accs[k];
}

const isRunning = (s: Slot): boolean => s.run_id != null && (s.state === "running" || s.state === "draining");

/** Live input/output tokens of lane k (0..2). Reactive on store.snap, so call it inside $derived. */
export function liveTokens(k: number): { input: number; output: number } {
  return liveOf(store.snap.slots[k].tokens, feed(k));
}

/** Model tokens per minute across the running lanes over the last 60 s. */
export function tokensPerMinute(): number {
  const run: Acc[] = [];
  for (let k = 0; k < 3; k++) {
    const a = feed(k);
    if (isRunning(store.snap.slots[k])) run.push(a);
  }
  return sumWindow(run, store.nowF() * 1000, 60_000);
}

// ---------------------------------------------------------------- pulse strip
let metricsSeen: unknown = null;
let metricsAt = 0;

/**
 * tokens_today plus the steps that arrived live after the last metrics update. The metrics object is
 * replaced as a whole, which is the moment the server's count catches up, so the extra restarts at 0.
 */
export function tokensToday(): number | null {
  const m = store.snap.metrics;
  return m ? m.tokens_today.input + m.tokens_today.output + liveExtra() : null;
}

/** tokens_total (input + output, every call ever) plus the same live steps; null from an older console. */
export function tokensTotal(): number | null {
  const t = store.snap.metrics?.tokens_total;
  return t ? t.input + t.output + liveExtra() : null;
}

function liveExtra(): number {
  void store.now; // re-evaluate once a second; tokenLog itself is not reactive
  const m = store.snap.metrics;
  if (m !== metricsSeen) { metricsSeen = m; metricsAt = Date.now(); }
  let extra = 0;
  for (let i = store.tokenLog.length - 1; i >= 0 && store.tokenLog[i].t > metricsAt; i--) extra += store.tokenLog[i].n;
  return extra;
}

// ---------------------------------------------------------------- flywheel
const fw = { angle: 0, w: 0.12, t: -1 };

/** Flywheel angular speed (rad/s) for a tokens/min figure. Idle keeps a slow breath. */
export function flySpeed(running: boolean, tpm: number): number {
  return running ? 0.6 + Math.min(9, tpm / 12_000) : 0.12;
}

/**
 * Flywheel angle at animation clock `t` (seconds, from the single rAF loop). The angular speed eases
 * to its target over ~1 s, so the wheel spins up and down instead of jumping.
 */
export function flywheel(t: number): number {
  const dt = fw.t < 0 ? 0 : clamp(t - fw.t, 0, 0.1);
  fw.t = t;
  if (dt > 0) {
    const target = flySpeed(store.snap.slots.some(isRunning), tokensPerMinute());
    fw.w += (target - fw.w) * (1 - Math.exp(-dt / 0.35));
    fw.angle += fw.w * dt;
  }
  return fw.angle;
}

// ---------------------------------------------------------------- count-up
const ease = (p: number): number => p * p * (3 - 2 * p);

/**
 * Eases a displayed number toward its target. `clock` is read only while a tween is in flight, so a
 * settled readout stops depending on the animation clock. Instant when `instant` (reduced motion).
 */
export class CountUp {
  private from = 0;
  private to: number | null = null;
  private t0 = 0;
  private cur = 0;

  read(target: number, clock: () => number, instant: boolean, dur = 0.5): number {
    if (this.to === null || instant) { this.to = target; this.cur = target; this.from = target; return target; }
    if (target !== this.to) { this.from = this.cur; this.to = target; this.t0 = clock(); }
    if (this.cur === this.to) return this.cur;
    const p = (clock() - this.t0) / dur;
    this.cur = p >= 1 ? this.to : this.from + (this.to - this.from) * ease(Math.max(0, p));
    return this.cur;
  }
}
