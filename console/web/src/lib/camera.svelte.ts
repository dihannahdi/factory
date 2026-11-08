// The camera: pan, zoom, fly-to and follow, all by rewriting the viewBox of the machine's SVG(s).
// Nothing is rasterised and no layout is touched: the browser just re-draws vectors at the new window.
// State is normalised to the figure's base box: (nx, ny) is the view centre as a fraction of the base
// box (0.5, 0.5 = centred) and z is the zoom (1 = the whole machine fits), so the same camera works
// for the desktop figure and for each single-lane phone figure.
export interface Box { x: number; y: number; w: number; h: number }
export interface View { el: SVGSVGElement; base: () => Box }

export const Z_MIN = 0.5;
export const Z_MAX = 6;
export const FOLLOW_Z = 2.7;
export const TOUR_Z = 2.4;
const KEY = "hc-cam";

/** UI-facing state. `z` is mirrored at a low rate for display; the animation itself uses plain numbers. */
export const cam = $state({ follow: false, followLane: 0, cinematic: false, tour: false, z: 1 });

const views = new Set<View>();
const cur = { nx: 0.5, ny: 0.5, z: 1 };
const tgt = { nx: 0.5, ny: 0.5, z: 1 };
const vel = { nx: 0, ny: 0, lz: 0 };
let animated = true; // false: reduced motion or the loop is not running -> every move is an instant jump
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- persistence
function load(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    tgt.nx = clamp(n(o.nx, 0.5), -1, 2);
    tgt.ny = clamp(n(o.ny, 0.5), -1, 2);
    tgt.z = clamp(n(o.z, 1), Z_MIN, Z_MAX);
    cur.nx = tgt.nx; cur.ny = tgt.ny; cur.z = tgt.z; cam.z = tgt.z;
    if (o.follow === true) cam.follow = true;
    if (o.tour === true) cam.tour = true;
    if (o.followLane === 1 || o.followLane === 2) cam.followLane = o.followLane;
  } catch { /* storage may be blocked or corrupt: start fitted */ }
}
function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ nx: tgt.nx, ny: tgt.ny, z: tgt.z, follow: cam.follow, followLane: cam.followLane, tour: cam.tour })); } catch { /* ignore */ }
  }, 400);
}
if (typeof window !== "undefined") load();

// ---------------------------------------------------------------- applying
export function viewBoxOf(base: Box, c = cur): string {
  const w = base.w / c.z, h = base.h / c.z;
  const cx = base.x + c.nx * base.w, cy = base.y + c.ny * base.h;
  return `${(cx - w / 2).toFixed(2)} ${(cy - h / 2).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`;
}
function apply(): void {
  for (const v of views) v.el.setAttribute("viewBox", viewBoxOf(v.base()));
}
export function register(v: View): () => void {
  views.add(v);
  v.el.setAttribute("viewBox", viewBoxOf(v.base()));
  return () => { views.delete(v); };
}
export function refresh(): void { apply(); }
export function setMotion(on: boolean): void { animated = on; if (!on) jump(); }

function jump(): void {
  cur.nx = tgt.nx; cur.ny = tgt.ny; cur.z = tgt.z; vel.nx = vel.ny = vel.lz = 0;
  cam.z = cur.z;
  apply();
}

/** Critically damped spring (Unity-style SmoothDamp): no overshoot, no jitter, same feel at any frame rate. */
function damp(c: number, t: number, v: "nx" | "ny" | "lz", smooth: number, dt: number): number {
  const omega = 2 / smooth, x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = c - t;
  const temp = (vel[v] + omega * change) * dt;
  vel[v] = (vel[v] - omega * temp) * e;
  return t + (change + temp) * e;
}

let tick = 0;
/** Advance the spring one frame. Cheap when nothing moves. */
export function stepCamera(dt: number): void {
  const moving = Math.abs(cur.nx - tgt.nx) > 1e-5 || Math.abs(cur.ny - tgt.ny) > 1e-5 || Math.abs(cur.z - tgt.z) > 1e-4 || Math.abs(vel.nx) + Math.abs(vel.ny) + Math.abs(vel.lz) > 1e-5;
  if (!moving) return;
  const smooth = cam.follow ? 0.7 : 0.28;
  cur.nx = damp(cur.nx, tgt.nx, "nx", smooth, dt);
  cur.ny = damp(cur.ny, tgt.ny, "ny", smooth, dt);
  cur.z = Math.exp(damp(Math.log(cur.z), Math.log(tgt.z), "lz", smooth, dt));
  apply();
  if (++tick % 6 === 0) cam.z = cur.z;
}

// ---------------------------------------------------------------- moves
function go(instant: boolean): void {
  if (instant || !animated) jump();
  save();
}
const primaryBase = (): Box | null => {
  for (const v of views) return v.base();
  return null;
};

/** Pan by a fraction of the current window (arrow keys). */
export function panFraction(fx: number, fy: number): void {
  markManual();
  cam.follow = false;
  tgt.nx += fx / tgt.z;
  tgt.ny += fy / tgt.z;
  go(false);
}

/** Pan by screen pixels while dragging: immediate, the content sticks to the finger. */
export function panPixels(el: SVGSVGElement, base: Box, dx: number, dy: number): void {
  markManual();
  cam.follow = false;
  const r = el.getBoundingClientRect();
  const s = Math.min(r.width / (base.w / cur.z), r.height / (base.h / cur.z));
  if (!(s > 0)) return;
  tgt.nx = cur.nx - dx / s / base.w;
  tgt.ny = cur.ny - dy / s / base.h;
  cur.nx = tgt.nx; cur.ny = tgt.ny; vel.nx = vel.ny = 0;
  apply();
  save();
}

/** Zoom by `factor`, keeping the point under (clientX, clientY) fixed. `instant` for pinch. */
export function zoomAt(el: SVGSVGElement, base: Box, factor: number, clientX: number, clientY: number, instant = false): void {
  markManual();
  cam.follow = false;
  const r = el.getBoundingClientRect();
  const z1 = clamp(tgt.z * factor, Z_MIN, Z_MAX);
  const scale = (z: number) => Math.min(r.width / (base.w / z), r.height / (base.h / z));
  const s0 = scale(tgt.z), s1 = scale(z1);
  if (!(s0 > 0) || !(s1 > 0)) return;
  const ox = clientX - (r.left + r.width / 2), oy = clientY - (r.top + r.height / 2);
  const ux = base.x + tgt.nx * base.w + ox / s0, uy = base.y + tgt.ny * base.h + oy / s0;
  tgt.nx = (ux - ox / s1 - base.x) / base.w;
  tgt.ny = (uy - oy / s1 - base.y) / base.h;
  tgt.z = z1;
  if (instant) { cur.nx = tgt.nx; cur.ny = tgt.ny; cur.z = tgt.z; vel.nx = vel.ny = vel.lz = 0; apply(); cam.z = cur.z; save(); } else go(false);
}

/** Zoom about the centre of the view (+ / - keys and buttons). */
export function zoomBy(factor: number): void {
  markManual();
  cam.follow = false;
  tgt.z = clamp(tgt.z * factor, Z_MIN, Z_MAX);
  go(false);
}

export function fit(): void {
  markManual();
  cam.follow = false;
  tgt.nx = 0.5; tgt.ny = 0.5; tgt.z = 1;
  go(false);
}

/** Fly so that the user-unit point (ux, uy) is centred at zoom z. Animated unless reduced motion. */
export function flyTo(ux: number, uy: number, z: number): void {
  const b = primaryBase();
  if (!b) return;
  markManual();
  cam.follow = false;
  tgt.nx = (ux - b.x) / b.w;
  tgt.ny = (uy - b.y) / b.h;
  tgt.z = clamp(z, Z_MIN, Z_MAX);
  go(false);
}

export function setFollow(on: boolean, lane = cam.followLane): void {
  markManual();
  cam.follow = on;
  cam.followLane = lane;
  if (on) tgt.z = FOLLOW_Z;
  go(false);
}

/** Called each frame by the animation loop while follow is on: aim at a user-unit point. */
export function followPoint(ux: number, uy: number): void {
  const b = primaryBase();
  if (!b || !cam.follow) return;
  tgt.nx = (ux - b.x) / b.w;
  tgt.ny = (uy - b.y) / b.h;
  tgt.z = cam.tour ? TOUR_Z : FOLLOW_Z;
  if (!animated) jump();
}

export function setCinematic(on: boolean): void {
  cam.cinematic = on;
}

// ---------------------------------------------------------------- auto-tour
// The tour is a small state machine run by AutoTour.svelte every ~250 ms. It only decides WHAT to aim at;
// the aiming itself reuses the follow spring (cam.follow + followPoint), so every move is the same eased move.
export const TOUR_DWELL_MS = 6000;
export const TOUR_PULL_EVERY_MS = 45_000;
export const TOUR_PULL_MS = 4000;
export const TOUR_PAUSE_MS = 15_000;

let manualAt = -1e12;
/** Any hand on the camera (drag, wheel, buttons, keys) calls this; the tour then stands down for TOUR_PAUSE_MS. */
function markManual(): void { manualAt = nowMs(); }
const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
export function lastManualAt(): number { return manualAt; }

export interface TourMem { lane: number; since: number; nextPull: number; pullUntil: number }
export interface TourIn {
  now: number;
  /** lanes that currently hold a running issue */
  active: boolean[];
  /** client time (ms) of the last tool event per lane, 0 = none yet */
  lastTool: number[];
  reduced: boolean;
  manualAt: number;
}
export type TourAct = { kind: "idle" } | { kind: "follow"; lane: number } | { kind: "fit" };

export function newTourMem(now: number): TourMem {
  return { lane: -1, since: now, nextPull: now + TOUR_PULL_EVERY_MS, pullUntil: 0 };
}

/** The lane that most recently produced a tool event among the active ones (ties: lowest index); -1 if none. */
export function freshestLane(active: boolean[], lastTool: number[]): number {
  let best = -1;
  for (let k = 0; k < active.length; k++) if (active[k] && (best < 0 || (lastTool[k] ?? 0) > (lastTool[best] ?? 0))) best = k;
  return best;
}

/** One decision. Mutates `m`. Pure otherwise: no DOM, no store. */
export function tourStep(m: TourMem, i: TourIn): TourAct {
  if (i.now - i.manualAt < TOUR_PAUSE_MS) { m.lane = -1; m.since = i.now; return { kind: "idle" }; }
  if (!i.reduced && i.now >= m.nextPull && i.now >= m.pullUntil) {
    m.pullUntil = i.now + TOUR_PULL_MS;
    m.nextPull = m.pullUntil + TOUR_PULL_EVERY_MS;
  }
  if (i.now < m.pullUntil) return { kind: "fit" };
  const best = freshestLane(i.active, i.lastTool);
  if (best < 0) { m.lane = -1; return { kind: "fit" }; }
  if (m.lane < 0 || !i.active[m.lane]) { m.lane = best; m.since = i.now; }
  else if (i.now - m.since >= TOUR_DWELL_MS && best !== m.lane && (i.lastTool[best] ?? 0) > (i.lastTool[m.lane] ?? 0)) { m.lane = best; m.since = i.now; }
  return { kind: "follow", lane: m.lane };
}

export function setTour(on: boolean): void {
  if (cam.tour === on) return;
  cam.tour = on;
  if (!on && cam.follow) cam.follow = false;
  save();
}

/** Tour moves: not manual, so they never pause the tour. */
export function tourFollow(lane: number): void {
  if (!cam.follow) cam.follow = true;
  if (cam.followLane !== lane) cam.followLane = lane;
  tgt.z = TOUR_Z;
}
export function tourFit(): void {
  if (cam.follow) cam.follow = false;
  tgt.nx = 0.5; tgt.ny = 0.5; tgt.z = 1;
  if (!animated) jump();
}

/** Screen position (client px) of a user-unit point in the primary view, for HTML overlays. */
export function userToClient(ux: number, uy: number): { x: number; y: number } | null {
  for (const v of views) {
    const r = v.el.getBoundingClientRect();
    const b = v.base();
    const w = b.w / cur.z, h = b.h / cur.z;
    const cx = b.x + cur.nx * b.w, cy = b.y + cur.ny * b.h;
    const s = Math.min(r.width / w, r.height / h);
    return { x: r.left + r.width / 2 + (ux - cx) * s, y: r.top + r.height / 2 + (uy - cy) * s };
  }
  return null;
}

/** Test and screenshot hook: where the camera is right now. */
export function snapshotCamera(): { nx: number; ny: number; z: number } {
  return { nx: cur.nx, ny: cur.ny, z: cur.z };
}

// dev-only hook for scripted camera tests and screenshots; folded away in the production build
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as Record<string, unknown>).__hc = { flyTo, zoomBy, fit, setFollow, snapshotCamera, cam, setTour };
