// Fixed geometry of the Foundry, in world units. Lane k runs along +x at y = k * LANE_DY.
import { project } from "./iso";
import type { P } from "./iso";
import type { Stage } from "./types";

export const LANE_DY = 10;
export const LANE_W = 8;
export const BELT_Y = 2.9; // belt starts this far into the lane
export const BELT_W = 2.2;
export const BELT_TOP = 1.0;
export const CABLE_Z = 4.7;
export const STACK = { x: 47, y: 10.5, w: 7, d: 7, base: 2.2, per: 0.16, max: 30 } as const;
export const MAST = { x: 52.9, y: 11.4 } as const;

export const laneY0 = (k: number): number => k * LANE_DY;
export const beltCy = (k: number): number => laneY0(k) + BELT_Y + BELT_W / 2;
export const padY = (k: number): number => 11.9 + k * 2.1;

export function stackTop(merged7d: number): number {
  return STACK.base + Math.min(Math.max(0, merged7d), STACK.max) * STACK.per;
}

/** Resting pose of the work item per stage: [x, y, z]. y depends on the lane for the late stages. */
export function itemPose(stage: Stage, k: number, top: number, prog = 0): [number, number, number] {
  const by = beltCy(k);
  const pad = padY(k);
  switch (stage) {
    case "pick": return [3, by, BELT_TOP];
    case "plan": return [9, by, BELT_TOP];
    case "build": return [15.5, by, BELT_TOP];
    case "verify": return [22, by, BELT_TOP - 0.45];
    case "review": return [28.5, by, BELT_TOP];
    case "pr": return [34.5, by, CABLE_Z - 1.55];
    case "ci": return [40.5, by + (pad - by) * 0.35, CABLE_Z - 1.55];
    case "merge": return [50.5, pad, top];
    case "deploy": return [50.5, pad, top + 0.2 + 3.0 * Math.min(0.95, Math.max(0, prog))];
    case "live": return [50.5, pad, top + 3.2];
  }
}

/** Stage -> x of its station, for the glow plate and the engraved stage mark. */
export const STATION_X: Record<Stage, number> = {
  pick: 3, plan: 9, build: 15.5, verify: 22, review: 28.5, pr: 34.5, ci: 40.5, merge: 50.5, deploy: 50.5, live: 50.5,
};

/** View box that frames the whole machine (measured from the drawn extents, not the bounding corners). */
export function machineBox(): { x: number; y: number; w: number; h: number } {
  return { x: -372, y: -132, w: 792, h: 512 };
}

/** View box for a single lane (mobile): the lane, the stack and its sky, nothing else. */
export function laneBox(k: number, pad = 10): { x: number; y: number; w: number; h: number } {
  const y0 = laneY0(k);
  // the extreme points of one lane plus the shared stack and its mast
  const pts: P[] = ([[-4.5, y0, 3], [-4.5, y0 + 8, 0], [44.5, y0, 7.6], [44.5, y0 + 8, 0], [54.6, 10.4, 11.5], [54.6, 17.9, 0], [47, 17.9, 0], [47, 10.4, 11.5]] as [number, number, number][]).map((q) => project(q[0], q[1], q[2]));
  const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  const ya = Math.min(...pts.map((p) => p[1])), yb = Math.max(...pts.map((p) => p[1]));
  return { x: x0 - pad, y: ya - pad, w: x1 - x0 + 2 * pad, h: yb - ya + 2 * pad };
}

/** Ropeway ends for lane k: the pylon at the belt's end, and the pylon beside the stack. */
export const cableA = (k: number): [number, number, number] => [33.5, beltCy(k), CABLE_Z + 0.15];
export const cableB = (k: number, top: number): [number, number, number] => [46.2, padY(k), top + 2.4];
export function cableAt(k: number, top: number, x: number): number {
  const a = cableA(k), b = cableB(k, top);
  const t = Math.min(1, Math.max(0, (x - a[0]) / (b[0] - a[0])));
  return a[2] + (b[2] - a[2]) * t;
}

/** Typical minutes per stage, used until the metrics have a usable (non-zero) median. */
export const DEFAULT_MEDIAN_MIN: Record<Stage, number> = { pick: 0.5, plan: 3, build: 26, verify: 7, review: 11, pr: 2, ci: 9, merge: 1, deploy: 8, live: 1 };
export function medianSecs(m: Partial<Record<Stage, number>> | undefined, stage: Stage): number {
  const v = m?.[stage];
  return (v != null && v > 0 ? v : DEFAULT_MEDIAN_MIN[stage]) * 60;
}
/** Fraction of the stage's typical duration that has elapsed, 0.. (not capped: callers decide). */
export function stageProgress(elapsedSecs: number | null, m: Partial<Record<Stage, number>> | undefined, stage: Stage): number {
  return elapsedSecs == null ? 0 : Math.max(0, elapsedSecs) / medianSecs(m, stage);
}
