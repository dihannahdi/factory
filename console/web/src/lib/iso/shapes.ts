// Solid shapes for the Foundry: every face is a flat polygon with one tone token, no gradients.
// Light comes from the upper left, so the face looking toward +y (screen left) is brighter than the
// face looking toward +x (screen right); tops are lightest. Faces are returned back to front.
import { pathOf, project } from "./project";
import type { P, P3 } from "./project";

export type Tone = "top" | "s1" | "s2" | "s3" | "s4" | "acc" | "paper" | "none";
export interface Face {
  d: string;
  tone: Tone;
}
export interface Tones {
  top?: Tone;
  left?: Tone;
  right?: Tone;
}

const LIGHT: P3 = [-0.5, 0.8, 0.6];
const LL = Math.hypot(...LIGHT);

/** Quantise a surface normal to one of the four side tones. */
export function toneForNormal(nx: number, ny: number, nz: number): Tone {
  const l = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / LL;
  if (l > 0.8) return "s1";
  if (l > 0.3) return "s2";
  if (l > -0.5) return "s3";
  return "s4";
}

const face = (pts: P3[], tone: Tone): Face => ({ d: pathOf(pts.map((p) => project(p[0], p[1], p[2]))), tone });

/** Axis-aligned box. Visible faces only: left (+y side), right (+x side), top. */
export function box(x: number, y: number, z: number, w: number, d: number, h: number, t: Tones = {}): Face[] {
  const x1 = x + w, y1 = y + d, z1 = z + h;
  return [
    face([[x, y1, z], [x1, y1, z], [x1, y1, z1], [x, y1, z1]], t.left ?? "s2"),
    face([[x1, y, z], [x1, y1, z], [x1, y1, z1], [x1, y, z1]], t.right ?? "s3"),
    face([[x, y, z1], [x1, y, z1], [x1, y1, z1], [x, y1, z1]], t.top ?? "top"),
  ];
}

/** Flat horizontal quad (no thickness). */
export function plate(x: number, y: number, z: number, w: number, d: number, tone: Tone = "top"): Face {
  return face([[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z]], tone);
}

const ccw = (poly: P[]): P[] => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a < 0 ? poly.slice().reverse() : poly;
};

/** Vertical prism over an arbitrary xy polygon. */
export function prism(poly: P[], z: number, h: number, t: Tones = {}): Face[] {
  const pts = ccw(poly);
  const sides: { f: Face; k: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const nx = q[1] - p[1], ny = -(q[0] - p[0]); // outward normal for a counter-clockwise polygon
    if (nx + ny <= 1e-9) continue; // faces away from the viewer
    const len = Math.hypot(nx, ny) || 1;
    const tone = nx / len > 0.99 ? (t.right ?? toneForNormal(1, 0, 0)) : ny / len > 0.99 ? (t.left ?? toneForNormal(0, 1, 0)) : toneForNormal(nx / len, ny / len, 0);
    sides.push({ f: face([[p[0], p[1], z], [q[0], q[1], z], [q[0], q[1], z + h], [p[0], p[1], z + h]], tone), k: p[0] + q[0] + p[1] + q[1] });
  }
  sides.sort((a, b) => a.k - b.k);
  return [...sides.map((s) => s.f), face(pts.map((p) => [p[0], p[1], z + h] as P3), t.top ?? "top")];
}

/** Rectangle rotated about the vertical axis through (cx, cy). */
export function rotBox(cx: number, cy: number, z: number, len: number, wid: number, h: number, yaw: number, t: Tones = {}): Face[] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const pts: P[] = ([[-len / 2, -wid / 2], [len / 2, -wid / 2], [len / 2, wid / 2], [-len / 2, wid / 2]] as P[]).map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
  return prism(pts, z, h, t);
}

const arcPts = (n: number, a0: number, a1: number): number[] => Array.from({ length: n + 1 }, (_, i) => a0 + ((a1 - a0) * i) / n);

/** Upright cylinder; the visible half is cut into shaded bands. */
export function cylV(cx: number, cy: number, z: number, r: number, h: number, seg = 14, t: Tones = {}): Face[] {
  const out: Face[] = [];
  const a = arcPts(seg, -Math.PI / 4, (3 * Math.PI) / 4);
  for (let i = 0; i < seg; i++) {
    const m = (a[i] + a[i + 1]) / 2;
    const p = (ang: number, zz: number): P3 => [cx + r * Math.cos(ang), cy + r * Math.sin(ang), zz];
    out.push(face([p(a[i], z), p(a[i + 1], z), p(a[i + 1], z + h), p(a[i], z + h)], toneForNormal(Math.cos(m), Math.sin(m), 0)));
  }
  out.push(disc(cx, cy, z + h, r, t.top ?? "top", seg * 2));
  return out;
}

export function disc(cx: number, cy: number, z: number, r: number, tone: Tone = "top", seg = 20): Face {
  return face(arcPts(seg, 0, Math.PI * 2).slice(0, seg).map((a) => [cx + r * Math.cos(a), cy + r * Math.sin(a), z] as P3), tone);
}

/** Cylinder lying along x or y, starting at (x, y, z) at its axis. */
export function cylAxis(axis: "x" | "y", x: number, y: number, z: number, len: number, r: number, seg = 12, cap: Tone = "s1"): Face[] {
  const out: Face[] = [];
  const a = arcPts(seg, -Math.PI / 4, (3 * Math.PI) / 4);
  const at = (ang: number, l: number): P3 => (axis === "x" ? [x + l, y + r * Math.cos(ang), z + r * Math.sin(ang)] : [x + r * Math.cos(ang), y + l, z + r * Math.sin(ang)]);
  for (let i = 0; i < seg; i++) {
    const m = (a[i] + a[i + 1]) / 2;
    const n: P3 = axis === "x" ? [0, Math.cos(m), Math.sin(m)] : [Math.cos(m), 0, Math.sin(m)];
    out.push(face([at(a[i], 0), at(a[i + 1], 0), at(a[i + 1], len), at(a[i], len)], toneForNormal(n[0], n[1], n[2])));
  }
  out.push(face(arcPts(seg * 2, 0, Math.PI * 2).slice(0, seg * 2).map((ang) => at(ang, len)), cap));
  return out;
}

/** Point on the +end disc of a lying cylinder (for dots and ticks on the cap). */
export function capPoint(axis: "x" | "y", x: number, y: number, z: number, len: number, rr: number, ang: number): P {
  return axis === "x" ? project(x + len, y + rr * Math.cos(ang), z + rr * Math.sin(ang)) : project(x + rr * Math.cos(ang), y + len, z + rr * Math.sin(ang));
}

/** Open polyline in world space, as a path string. */
export const line3 = (pts: P3[]): string => pathOf(pts.map((p) => project(p[0], p[1], p[2])), false);

/** Floor-parallel ellipse path in world space (radius in world units). */
export function ring(cx: number, cy: number, z: number, r: number, seg = 24): string {
  return pathOf(arcPts(seg, 0, Math.PI * 2).slice(0, seg).map((a) => project(cx + r * Math.cos(a), cy + r * Math.sin(a), z)));
}

export const merge = (...parts: Face[][]): Face[] => parts.flat();

/** Painter's order: further from the viewer (smaller x + y) first. */
export function boxDepth(x: number, y: number, z: number, w: number, d: number, h: number): number {
  return x + w + (y + d) + (z + h) * 0.01;
}
export function sortByDepth<T extends { depth: number }>(items: T[]): T[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => a.it.depth - b.it.depth || a.i - b.i).map((v) => v.it);
}

/** Vertical disc in the plane y = const (looks toward +y, the "left" face of boxes). */
export function discXZ(cx: number, y: number, cz: number, r: number, tone: Tone = "top", seg = 18): Face {
  return face(arcPts(seg, 0, Math.PI * 2).slice(0, seg).map((a) => [cx + r * Math.cos(a), y, cz + r * Math.sin(a)] as P3), tone);
}

/** Vertical disc in the plane x = const (looks toward +x, the "right" face of boxes). */
export function discYZ(x: number, cy: number, cz: number, r: number, tone: Tone = "top", seg = 18): Face {
  return face(arcPts(seg, 0, Math.PI * 2).slice(0, seg).map((a) => [x, cy + r * Math.cos(a), cz + r * Math.sin(a)] as P3), tone);
}

/** Toothed gear lying in the plane y = const (looks toward +y). `rot` in radians. */
export function gearXZ(cx: number, y: number, cz: number, r: number, teeth: number, rot: number, tone: Tone = "s1"): Face {
  const pts: P3[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = rot + (i / teeth) * Math.PI * 2, w = Math.PI / teeth;
    for (const [da, rr] of [[-0.9, 0.82], [-0.45, 1], [0.45, 1], [0.9, 0.82]] as const) {
      const ang = a + da * w;
      pts.push([cx + Math.cos(ang) * r * rr, y, cz + Math.sin(ang) * r * rr]);
    }
  }
  return face(pts, tone);
}

/** Open arc on the floor plane, p in 0..1 of a full turn from the back corner. */
export function ringArc(cx: number, cy: number, z: number, r: number, p: number, seg = 40): string {
  const n = Math.max(1, Math.round(seg * Math.min(1, Math.max(0, p))));
  const a0 = -Math.PI * 0.75;
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / seg) * Math.PI * 2;
    pts.push(project(cx + r * Math.cos(a), cy + r * Math.sin(a), z));
  }
  return pathOf(pts, false);
}
