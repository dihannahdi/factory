import { describe, expect, it } from "vitest";
import { COS30, U, bounds, project, unproject, topMatrix } from "../src/lib/iso/project";
import { box, boxDepth, cylV, prism, sortByDepth, toneForNormal } from "../src/lib/iso/shapes";
import { machineBox, laneBox, stackTop } from "../src/lib/layout";

describe("isometric projection", () => {
  it("origin maps to origin", () => expect(project(0, 0, 0)).toEqual([0, 0]));
  it("x axis runs 30 degrees below horizontal to the right", () => {
    const [x, y] = project(1, 0, 0);
    expect(x).toBeCloseTo(COS30 * U);
    expect(y).toBeCloseTo(0.5 * U);
    expect(Math.atan2(y, x) * (180 / Math.PI)).toBeCloseTo(30);
  });
  it("y axis runs 30 degrees below horizontal to the left", () => {
    const [x, y] = project(0, 1, 0);
    expect(x).toBeCloseTo(-COS30 * U);
    expect(y).toBeCloseTo(0.5 * U);
  });
  it("z is straight up", () => expect(project(0, 0, 1)).toEqual([0, -U]));
  it("moving (1,1,1) is invisible: that is the view direction", () => {
    const [x, y] = project(1, 1, 1);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
  });
  it("unproject inverts project on a plane", () => {
    const [sx, sy] = project(7.5, -3.25, 2);
    const w = unproject(sx, sy, 2);
    expect(w.x).toBeCloseTo(7.5);
    expect(w.y).toBeCloseTo(-3.25);
  });
  it("is linear: project(a+b) = project(a)+project(b)", () => {
    const a = project(2, 3, 1), b = project(-1, 4, 2), c = project(1, 7, 3);
    expect(c[0]).toBeCloseTo(a[0] + b[0]);
    expect(c[1]).toBeCloseTo(a[1] + b[1]);
  });
  it("text matrix lays the unit x vector along the x axis", () => {
    expect(topMatrix(0, 0, 0)).toBe("matrix(8.66 5 -8.66 5 0 0)");
  });
});

describe("shapes and painter's order", () => {
  it("a box has exactly three visible faces, top last", () => {
    expect(box(0, 0, 0, 1, 1, 1).map((x) => x.tone)).toEqual(["s2", "s3", "top"]);
  });
  it("face tones follow the light: +y side brighter than +x side", () => {
    expect(toneForNormal(0, 1, 0)).toBe("s2");
    expect(toneForNormal(1, 0, 0)).toBe("s3");
    expect(toneForNormal(0, -1, 0)).toBe("s4");
  });
  it("nearer boxes sort after farther ones", () => {
    const items = [
      { id: "near", depth: boxDepth(4, 4, 0, 1, 1, 1) },
      { id: "far", depth: boxDepth(0, 0, 0, 1, 1, 1) },
      { id: "mid", depth: boxDepth(2, 1, 0, 1, 1, 1) },
    ];
    expect(sortByDepth(items).map((i) => i.id)).toEqual(["far", "mid", "near"]);
  });
  it("sort is stable for equal depth", () => {
    const items = [{ id: 1, depth: 3 }, { id: 2, depth: 3 }, { id: 3, depth: 1 }];
    expect(sortByDepth(items).map((i) => i.id)).toEqual([3, 1, 2]);
  });
  it("prism ignores winding and keeps only viewer-facing sides", () => {
    const sq: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    const a = prism(sq, 0, 1), b = prism(sq.slice().reverse(), 0, 1);
    expect(a).toHaveLength(3);
    expect(b.map((f) => f.d).sort()).toEqual(a.map((f) => f.d).sort());
  });
  it("a cylinder is banded sides plus a top", () => {
    const f = cylV(0, 0, 0, 1, 1, 10);
    expect(f).toHaveLength(11);
    expect(f[10].tone).toBe("top");
  });
  it("bounds()", () => expect(bounds([[0, 1], [4, 5]])).toEqual({ x: 0, y: 1, w: 4, h: 4 }));
});

describe("layout", () => {
  it("stack height grows with merges and is capped at 30 layers", () => {
    expect(stackTop(0)).toBeLessThan(stackTop(5));
    expect(stackTop(30)).toBe(stackTop(300));
  });
  it("view boxes have positive size", () => {
    for (const b of [machineBox(), laneBox(0), laneBox(2)]) { expect(b.w).toBeGreaterThan(100); expect(b.h).toBeGreaterThan(100); }
  });
});
