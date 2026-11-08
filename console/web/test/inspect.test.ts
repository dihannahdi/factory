import { describe, expect, it } from "vitest";
import { chipsOf, filterItems, hull, isTap, itemKey, latestTouch, mergeItems, sanitizeInspect, sanitizeItem, splitPath } from "../src/lib/inspect-api";
import type { Item } from "../src/lib/types";

const tool = (t: number, name: string, target: string): Item => ({ t, kind: "tool", tool: name, target, text: null, status: "completed", tokens: null });

describe("sanitizeInspect repairs per field", () => {
  const good = {
    slot: 1, run_id: "r", stage: "build",
    issue: { n: 27, title: "[OUT-02] x", tag: "OUT-02", url: "https://github.com/a/b/issues/27" },
    pr: null,
    turn: { phase: "build", started: 1792137000, items: [tool(1792137000123, "bash", "ls")] },
    turns: [{ phase: "plan", file: "plan-0.jsonl", first: 1, last: 2, items: 64 }],
    files: [{ path: "crates/a.rs", edits: 7, reads: 3, last: 5 }],
    checklist: [{ item: "a", done: true, evidence: "e" }],
    plan: { decision: "go", slice: "s", requirements: ["r1"], files: ["f"], tests: "t" },
  };
  it("passes a good payload through", () => {
    const d = sanitizeInspect(good)!;
    expect(d.issue?.tag).toBe("OUT-02");
    expect(d.turn?.items).toHaveLength(1);
    expect(d.files[0].edits).toBe(7);
    expect(d.checklist?.[0].done).toBe(true);
    expect(d.plan?.requirements).toEqual(["r1"]);
  });
  it("one odd field never blanks the rest", () => {
    const d = sanitizeInspect({ ...good, issue: "oops", turn: { phase: 5, started: "x", items: "no" }, turns: {}, files: [null, { path: 3 }, { path: "ok.rs", edits: "x", reads: -2 }], checklist: "no", plan: { slice: 9, requirements: "x" } })!;
    expect(d.issue).toBeNull();
    expect(d.turn?.items).toEqual([]);
    expect(d.turns).toEqual([]);
    expect(d.files).toEqual([{ path: "ok.rs", edits: 0, reads: 0, last: 0 }]);
    expect(d.checklist).toBeNull();
    expect(d.plan?.slice).toBeNull();
    expect(d.plan?.requirements).toEqual([]);
    expect(d.stage).toBe("build");
    expect(d.slot).toBe(1);
  });
  it("drops bad items one by one and non-https links", () => {
    const d = sanitizeInspect({ ...good, issue: { n: 1, title: "t", url: "javascript:alert(1)" }, turn: { phase: "b", started: 1, items: [null, { t: "x" }, { t: 5, kind: "wat" }, tool(9, "read", "a"), { t: 10, kind: "text", text: "hi\u0000\nthere" }] } })!;
    expect(d.issue?.url).toBeNull();
    expect(d.turn?.items.map((i) => i.t)).toEqual([9, 10]);
    expect(d.turn?.items[1].text).toBe("hi there");
  });
  it("returns null only for a non-object body, and never throws", () => {
    expect(sanitizeInspect(null)).toBeNull();
    expect(sanitizeInspect([])).toBeNull();
    expect(sanitizeInspect({})).not.toBeNull();
    expect(() => sanitizeInspect({ turn: { items: [{ t: NaN }, { t: Infinity, kind: "tool" }] }, checklist: [1, 2, { item: {} }] })).not.toThrow();
  });
  it("sanitizeItem infers a missing kind", () => {
    expect(sanitizeItem({ t: 3, tool: "bash", target: "x" })?.kind).toBe("tool");
    expect(sanitizeItem({ t: 3 })).toBeNull();
  });
});

describe("click vs drag", () => {
  it("under 5 px is a tap, 5 and over is a drag", () => {
    expect(isTap({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(isTap({ x: 10, y: 10 }, { x: 13, y: 13 })).toBe(true); // 4.24
    expect(isTap({ x: 10, y: 10 }, { x: 15, y: 10 })).toBe(false);
    expect(isTap({ x: 0, y: 0 }, { x: 40, y: 2 })).toBe(false);
  });
  it("hull of a box projection keeps only the outline", () => {
    const h = hull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [1, 1]]);
    expect(h).toHaveLength(4);
  });
});

describe("transcript merge", () => {
  const a = tool(100, "bash", "ls"), b = tool(200, "read", "x.rs"), c = tool(300, "edit", "x.rs");
  it("dedupes by timestamp and keeps oldest first", () => {
    const m = mergeItems([a, b], [b, c]);
    expect(m.map((i) => i.t)).toEqual([100, 200, 300]);
  });
  it("returns the same array when nothing is new (a $state.raw no-op)", () => {
    const base = [a, b];
    expect(mergeItems(base, [a, b])).toBe(base);
    expect(mergeItems(base, [])).toBe(base);
  });
  it("sorts late arrivals into place", () => {
    expect(mergeItems([a, c], [b]).map((i) => i.t)).toEqual([100, 200, 300]);
  });
  it("keeps two different items that share a millisecond", () => {
    expect(mergeItems([a], [tool(100, "read", "y")])).toHaveLength(2);
    expect(itemKey(a)).toBe(itemKey({ ...a }));
  });
  it("drops items older than the floor (previous turn) and caps the length", () => {
    expect(mergeItems([], [a, b, c], 150).map((i) => i.t)).toEqual([200, 300]);
    const many = Array.from({ length: 50 }, (_, i) => tool(1000 + i, "bash", `c${i}`));
    const m = mergeItems([], many, 0, 10);
    expect(m).toHaveLength(10);
    expect(m[9].t).toBe(1049);
  });
});

describe("filters and touches", () => {
  const items: Item[] = [tool(1, "bash", "ls"), tool(2, "read", "a.rs"), { t: 3, kind: "text", text: "hm" }, { t: 4, kind: "step", tokens: { in: 1, out: 2 } }, { t: 5, kind: "error", text: "boom" }, tool(6, "edit", "b.rs"), tool(7, "bash", "pwd")];
  it("chips by frequency, steps excluded", () => {
    const c = chipsOf(items);
    expect(c[0]).toEqual({ id: "bash", n: 2 });
    expect(c.map((x) => x.id)).not.toContain("step");
    expect(c.map((x) => x.id)).toContain("error");
  });
  it("empty filter shows everything, a filter only matching rows", () => {
    expect(filterItems(items, new Set())).toHaveLength(7);
    expect(filterItems(items, new Set(["bash"])).map((i) => i.t)).toEqual([1, 7]);
    expect(filterItems(items, new Set(["text", "error"])).map((i) => i.t)).toEqual([3, 5]);
  });
  it("latest touched file ignores bash and later non-file tools", () => {
    expect(latestTouch(items)).toEqual({ path: "b.rs", t: 6 });
    expect(latestTouch([tool(1, "bash", "ls")])).toBeNull();
  });
  it("splitPath", () => {
    expect(splitPath("crates/shop-core/src/a.rs")).toEqual({ dir: "crates/shop-core/src/", base: "a.rs" });
    expect(splitPath("a.rs")).toEqual({ dir: "", base: "a.rs" });
  });
});
