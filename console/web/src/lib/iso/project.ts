// True isometric projection: 30 degree axes, no perspective.
// World: x runs to the lower right, y to the lower left, z up. One world unit is U screen units.
export const U = 10;
export const COS30 = Math.cos(Math.PI / 6);
export type P = [number, number];
export type P3 = [number, number, number];

export function project(x: number, y: number, z = 0): P {
  return [(x - y) * COS30 * U, (x + y) * 0.5 * U - z * U];
}

/** Inverse of project() on the horizontal plane at height z. */
export function unproject(sx: number, sy: number, z = 0): { x: number; y: number } {
  const a = sx / (COS30 * U); // x - y
  const b = (sy + z * U) / (0.5 * U); // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Round to 2 decimals so path strings stay short and stable. */
export const r2 = (v: number): number => Math.round(v * 100) / 100;

export const pathOf = (pts: P[], close = true): string =>
  pts.length === 0 ? "" : "M" + pts.map((p) => `${r2(p[0])} ${r2(p[1])}`).join("L") + (close ? "Z" : "");

export const pathOf3 = (pts: P3[], close = false): string => pathOf(pts.map((p) => project(p[0], p[1], p[2])), close);

/** SVG matrix that lays 2D text (units: world units, font-size in units) flat on a horizontal plane. */
export function topMatrix(x: number, y: number, z: number): string {
  const [e, f] = project(x, y, z);
  return `matrix(${r2(COS30 * U)} ${r2(0.5 * U)} ${r2(-COS30 * U)} ${r2(0.5 * U)} ${r2(e)} ${r2(f)})`;
}

/** Same for the face that looks toward +y ("left" on screen) and toward +x ("right"). */
export function faceMatrix(side: "left" | "right", x: number, y: number, z: number): string {
  const [e, f] = project(x, y, z);
  if (side === "left") return `matrix(${r2(COS30 * U)} ${r2(0.5 * U)} 0 ${U} ${r2(e)} ${r2(f)})`;
  return `matrix(${r2(COS30 * U)} ${r2(-0.5 * U)} 0 ${U} ${r2(e)} ${r2(f)})`;
}

export function bounds(pts: P[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
