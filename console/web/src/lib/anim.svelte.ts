// Animation clock and per-lane work-item poses. Driven by requestAnimationFrame, but every target
// comes from the store, so what moves is always what the numbers say. With reduced motion the loop
// never runs: poses snap straight to their targets and state shows through lit parts only.
import { untrack } from "svelte";
import { project } from "./iso";
import { itemPose, stageProgress, stackTop } from "./layout";
import { cam, followPoint, setMotion, stepCamera } from "./camera.svelte";
import { store } from "./store.svelte";

export interface LaneAnim {
  x: number; y: number; z: number; yaw: number;
  o: number; // item opacity 0..1
  runId: string | null;
  press: number; // 0 (up) .. 1 (down), per tool strike
  osc: number; // idle oscillation while the model thinks (0..1, eased)
  strokeAt: number; // clock time the current stroke began, -1 when none
  strokeSeen: number; // store.strokes already turned into strokes
  strokeQueue: number;
  rate: number; // tool items per second over ~12 s, smoothed (bursts)
  rate60: number; // tool items per second over 60 s, smoothed (crawl vs run)
  gate: number; // turnstile angle
  gear: number; // gear angle at the active station
  verifyAt: number; // bubble phase accumulator
  belt: number; // belt slat phase
  spark: number; // particle phase
  liftP: number; // deploy lift progress 0..1
  flick: number;
}
const mk = (): LaneAnim => ({
  x: -3, y: 4, z: 1, yaw: 1.6, o: 0, runId: null, press: 0, osc: 0, strokeAt: -1, strokeSeen: 0, strokeQueue: 0, rate: 0, rate60: 0,
  gate: 0, gear: 0, verifyAt: 0, belt: 0, spark: 0, liftP: 0, flick: 0,
});

/** `fly` is the flywheel's angle: the system heartbeat, faster with tokens/min. */
export const anim = $state({ t: 0, reduced: false, visible: true, running: false, fly: 0 });
export const lanes = $state<LaneAnim[]>([mk(), mk(), mk()]);

const STROKE_S = 0.46;
const ease = (p: number): number => p * p * (3 - 2 * p);
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** Belt speed in units/s from the two activity windows: slow crawl while waiting, fast in tool bursts. */
export function beltSpeed(state: string, has: boolean, burst: number, avg: number): number {
  if (state === "parked") return 0;
  if (!has) return 0.06; // idle: very slow
  return 0.22 + Math.min(2.4, Math.max(avg * 4, burst * 3));
}

/** One simulation step. dt in seconds; a big dt snaps everything to its target. */
export function step(dt: number): void {
  const snap = store.snap;
  const top = stackTop(snap.metrics?.merged_7d ?? 0);
  const snapAll = dt >= 5;
  const k1 = snapAll ? 1 : 1 - Math.exp(-dt * 3.2);
  anim.t += snapAll ? 0 : dt;
  const nowMs = Date.now();
  const nowS = store.nowF();
  const anyRunning = snap.slots.some((s) => s.run_id && (s.state === "running" || s.state === "draining"));
  for (let k = 0; k < 3; k++) {
    const L = lanes[k];
    const s = snap.slots[k];
    const has = !!(s.issue && s.run_id);
    const working = has && (s.state === "running" || s.state === "draining");
    if (s.run_id !== L.runId) {
      // a new issue was picked: start on the infeed, turned sideways, then rotate in
      L.runId = s.run_id;
      if (has) { L.x = -2.4; L.yaw = 1.57; L.o = snapAll ? 1 : 0; const p = itemPose("pick", k, top); L.y = p[1]; L.z = p[2]; }
    }
    if (has && s.stage) {
      // deploy: the lift rises with elapsed / median deploy time, and snaps to the top on live
      const prog = s.stage === "deploy" ? stageProgress(s.stage_started != null ? nowS - s.stage_started : null, snap.metrics?.stage_median_min, "deploy") : 0;
      L.liftP = clamp(prog, 0, 0.95);
      let [tx, ty, tz] = itemPose(s.stage, k, top, prog);
      // The quench tank (Lane.svelte TANK: centre x 22, half-length 2, rim z 1.6) has walls, and
      // x, y and z ease together, so a straight move would pass the ingot (half-length 1.75)
      // through them. Around the tank the ingot climbs in place to clear the rim, travels above
      // it, and only dips once it is over the tank's centre; leaving, it climbs out first.
      if (!snapAll) {
        const CX = 22, REACH = 2.0 + 1.75 + 0.2, CLEAR = 1.75;
        const dip = s.stage === "verify";
        const centred = Math.abs(L.x - CX) < 0.3 && Math.abs(L.y - ty) < 0.3;
        if (!(dip && centred) && (dip || Math.abs(L.x - CX) < REACH)) {
          if (L.z < CLEAR - 0.05) { tx = L.x; ty = L.y; }
          tz = CLEAR;
        }
      }
      L.x += (tx - L.x) * k1; L.y += (ty - L.y) * k1; L.z += (tz - L.z) * k1;
      L.yaw += (0 - L.yaw) * (snapAll ? 1 : 1 - Math.exp(-dt * 1.6));
    }
    const live = has && s.state !== "stopped" ? 1 : 0;
    L.o += (live - L.o) * (snapAll ? 1 : 1 - Math.exp(-dt * 4));
    // activity rates and press strokes
    L.rate += (store.rate(k, nowMs, 12_000) - L.rate) * (snapAll ? 1 : 1 - Math.exp(-dt * 1.5));
    L.rate60 += (store.rate(k, nowMs, 60_000) - L.rate60) * (snapAll ? 1 : 1 - Math.exp(-dt * 0.6));
    const seen = store.strokes[k];
    if (seen > L.strokeSeen) {
      L.strokeQueue = Math.min(6, L.strokeQueue + (seen - L.strokeSeen));
      L.strokeSeen = seen;
    }
    if (!snapAll) {
      if (L.strokeAt < 0 && L.strokeQueue > 0) { L.strokeAt = anim.t; L.strokeQueue--; }
      if (L.strokeAt >= 0) {
        const p = (anim.t - L.strokeAt) / STROKE_S;
        if (p >= 1) { L.press = 0; L.strokeAt = -1; }
        else L.press = p < 0.32 ? ease(p / 0.32) : 1 - ease((p - 0.32) / 0.68);
      }
      const thinking = working && store.thinking(k, nowMs);
      // model thinking: subtle idle oscillation of the press, slow gear; a tool burst turns the gear faster
      L.osc += ((thinking ? 0.5 + 0.5 * Math.sin(anim.t * 2.1) : 0) - L.osc) * (1 - Math.exp(-dt * 5));
      L.gear += dt * (working ? (thinking ? 0.7 : 0.9 + Math.min(5, L.rate * 6)) : 0);
      L.gate += dt * (has && s.stage === "pick" ? 2.2 : anyRunning ? 0.35 : 0.5);
      L.verifyAt += dt * (s.stage === "verify" ? (/^fix /.test(s.sub) ? 1.9 : 1) : 0.15);
      L.belt += dt * beltSpeed(s.state, has, L.rate, L.rate60);
      L.spark += dt * (working ? 1 : 0);
      L.flick = Math.sin(anim.t * 41) + Math.sin(anim.t * 17.3);
    } else { L.press = 0; L.strokeAt = -1; L.strokeQueue = 0; L.osc = 0; }
  }
  // camera follow: aim at the work item of the chosen lane (the accent spot); the spring does the easing
  if (cam.follow) {
    const L = lanes[cam.followLane];
    const s = snap.slots[cam.followLane];
    if (s.issue && s.run_id && L.o > 0.05) {
      const [ux, uy] = project(L.x, L.y, L.z + 1.2);
      followPoint(ux, uy);
    }
  }
  if (!snapAll) {
    stepCamera(dt);
    // flywheel: tokens/min across running lanes; idle tour keeps it breathing
    const tpm = store.tokensPerMin(nowMs);
    anim.fly += dt * (anyRunning ? 0.6 + Math.min(9, tpm / 12_000) : 0.12);
  }
}

let raf = 0;
let last = 0;
let io: IntersectionObserver | null = null;
let mql: MediaQueryList | null = null;

function frame(ts: number): void {
  raf = 0;
  if (!anim.running) return;
  const dt = clamp((ts - last) / 1000, 0, 0.05);
  last = ts;
  step(dt);
  raf = requestAnimationFrame(frame);
}

function wanted(): boolean {
  return !anim.reduced && anim.visible && typeof document !== "undefined" && document.visibilityState === "visible";
}

function sync(): void {
  const want = wanted();
  setMotion(want);
  if (want && !anim.running) { anim.running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  else if (!want && anim.running) { anim.running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  if (!want && anim.reduced) step(10); // static machine: poses follow state, nothing moves
}

/** Call once. `target` is the figure element: the loop sleeps while it is off-screen. */
export function initAnim(target: Element): () => void {
  mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  anim.reduced = mql.matches;
  const onMq = () => { anim.reduced = mql!.matches; sync(); };
  mql.addEventListener("change", onMq);
  io = new IntersectionObserver((e) => { anim.visible = e.some((x) => x.isIntersecting); sync(); }, { threshold: 0 });
  io.observe(target);
  const onVis = () => sync();
  document.addEventListener("visibilitychange", onVis);
  sync();
  return () => {
    io?.disconnect();
    mql?.removeEventListener("change", onMq);
    document.removeEventListener("visibilitychange", onVis);
    anim.running = false;
    if (raf) cancelAnimationFrame(raf);
  };
}

/** Reduced motion: re-pose after every store change (called from an effect). */
export function settle(): void {
  untrack(() => { if (anim.reduced) step(10); });
}

if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as Record<string, unknown>).__hcAnim = { lanes };
