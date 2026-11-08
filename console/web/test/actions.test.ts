import { describe, expect, it } from "vitest";
import { DURATION, LaneActions, MAX_RUNNING, NONE, SPACING, anchorCtx, bathCtx, classify, draw, itemKey, stillPrims } from "../src/lib/actions.svelte";
import type { ActionKind, Prim } from "../src/lib/actions.svelte";
import type { Item } from "../src/lib/types";

const tool = (t: number, name: string, target: string, status = "completed"): Item => ({ t, kind: "tool", tool: name, target, text: null, status, tokens: null });
const NOW = 1_000_000;
const ctx = () => anchorCtx("build", 0, 4);
const ctxFor = (k: ActionKind) => (k === "test" ? bathCtx(0) : ctx());

describe("item -> action", () => {
  it("maps tools", () => {
    expect(classify(tool(1, "read", "a.md"))?.kind).toBe("read");
    expect(classify(tool(1, "edit", "a.rs"))?.kind).toBe("strike");
    expect(classify(tool(1, "write", "a.rs"))?.kind).toBe("strike");
    expect(classify(tool(1, "grep", "x"))?.kind).toBe("scan");
    expect(classify(tool(1, "glob", "x"))?.kind).toBe("scan");
    expect(classify(tool(1, "list", "x"))?.kind).toBe("scan");
    expect(classify(tool(1, "task", "x"))?.kind).toBe("drone");
    expect(classify(tool(1, "webfetch", "https://x"))?.kind).toBe("antenna");
  });
  it("splits bash by command", () => {
    expect(classify(tool(1, "bash", "cargo test -p shop-core"))?.kind).toBe("test");
    expect(classify(tool(1, "bash", "npm test"))?.kind).toBe("test");
    expect(classify(tool(1, "bash", "cargo build --workspace --locked && cargo test"))?.kind).toBe("test");
    expect(classify(tool(1, "bash", "cargo build --workspace --locked"))?.kind).toBe("build");
    expect(classify(tool(1, "bash", "npm run build"))?.kind).toBe("build");
    expect(classify(tool(1, "bash", "ls -la"))?.kind).toBe("pump");
  });
  it("text, step and error", () => {
    expect(classify({ t: 1, kind: "text", text: "hi" })?.kind).toBe("ink");
    expect(classify({ t: 1, kind: "step", tokens: { in: 1, out: 2 } })?.kind).toBe("tick");
    expect(classify({ t: 1, kind: "error", text: "boom" })).toEqual({ kind: "pump", error: true });
  });
  it("tool status error flags the action", () => {
    expect(classify(tool(1, "edit", "a", "error"))).toEqual({ kind: "strike", error: true });
  });
});

describe("dedupe", () => {
  it("does not replay the backlog on first load", () => {
    const e = new LaneActions();
    const list = [tool(NOW - 100, "read", "a"), tool(NOW - 50, "edit", "b")];
    expect(e.ingest(list, NOW)).toEqual([]);
    expect(e.queue.length).toBe(0);
  });
  it("plays only items that arrive afterwards, once", () => {
    const e = new LaneActions();
    const a = tool(NOW - 100, "read", "a");
    e.ingest([a], NOW);
    const b = tool(NOW, "edit", "b");
    expect(e.ingest([a, b], NOW)).toHaveLength(1);
    expect(e.ingest([a, b, tool(NOW, "edit", "b")].slice(0, 2).concat([]), NOW)).toHaveLength(0);
    expect(e.queue.map((q) => q.kind)).toEqual(["strike"]);
  });
  it("a reset (nothing in common) plays nothing", () => {
    const e = new LaneActions();
    e.ingest([tool(NOW - 100, "read", "a")], NOW);
    expect(e.ingest([tool(NOW - 90, "edit", "x"), tool(NOW - 80, "edit", "y")], NOW)).toEqual([]);
  });
  it("ignores items that are already old", () => {
    const e = new LaneActions();
    e.ingest([tool(NOW - 100, "read", "a")], NOW);
    const old = tool(NOW - 60_000, "edit", "z");
    expect(e.ingest([tool(NOW - 100, "read", "a"), old], NOW)).toEqual([]);
  });
  it("keys differ by time, tool and target", () => {
    expect(itemKey(tool(1, "read", "a"))).not.toBe(itemKey(tool(2, "read", "a")));
    expect(itemKey(tool(1, "read", "a"))).not.toBe(itemKey(tool(1, "edit", "a")));
    expect(itemKey(tool(1, "read", "a"))).not.toBe(itemKey(tool(1, "read", "b")));
  });
});

describe("queue", () => {
  const burst = () => {
    const e = new LaneActions();
    const base = [tool(NOW - 10, "read", "seed")];
    e.ingest(base, NOW);
    const items = [...base, ...Array.from({ length: 6 }, (_, i) => tool(NOW + i, "task", `f${i}`))];
    e.ingest(items, NOW + 10);
    return e;
  };
  it("starts one at a time, SPACING apart, at most MAX_RUNNING", () => {
    const e = burst();
    let t = 100;
    expect(e.advance(t, NOW, ctxFor).length).toBe(1);
    expect(e.advance(t + SPACING / 2, NOW, ctxFor).length).toBe(1);
    t += SPACING + 0.001;
    expect(e.advance(t, NOW, ctxFor).length).toBe(2);
    t += SPACING + 0.001;
    expect(e.advance(t, NOW, ctxFor).length).toBe(3);
    t += SPACING + 0.001;
    expect(e.advance(t, NOW, ctxFor).filter((r) => r.kind !== "tick").length).toBeLessThanOrEqual(MAX_RUNNING);
    expect(e.queue.length).toBeGreaterThan(0);
  });
  it("finished actions free a slot", () => {
    const e = burst();
    e.advance(100, NOW, ctxFor);
    expect(e.advance(100 + DURATION.drone + 0.01, NOW, ctxFor).length).toBe(1);
  });
  it("drops stale queued actions", () => {
    const e = burst();
    expect(e.advance(100, NOW + 60_000, ctxFor).length).toBe(0);
  });
  it("ticks run beside the queue", () => {
    const e = new LaneActions();
    e.ingest([tool(NOW - 10, "read", "s")], NOW);
    e.ingest([tool(NOW - 10, "read", "s"), { t: NOW, kind: "step", tokens: { in: 1, out: 1 } }], NOW);
    expect(e.advance(5, NOW, ctxFor).map((r) => r.kind)).toEqual(["tick"]);
  });
});

describe("drawing", () => {
  const kinds = Object.keys(DURATION) as ActionKind[];
  it("durations are 600..900 ms", () => {
    for (const k of kinds) { expect(DURATION[k]).toBeGreaterThanOrEqual(0.6); expect(DURATION[k]).toBeLessThanOrEqual(0.9); }
  });
  it("every gesture draws a bounded, finite set of primitives at every progress", () => {
    for (const k of kinds) for (const err of [false, true]) for (let p = 0; p <= 1.0001; p += 0.05) {
      const out: Prim[] = [];
      draw(k, p, ctx(), err, 3, false, out);
      expect(out.length).toBeLessThanOrEqual(30);
      for (const q of out) { expect(Number.isFinite(q.o)).toBe(true); expect(q.tf).not.toMatch(/NaN|Infinity/); expect(q.d.length).toBeGreaterThan(0); }
    }
  });
  it("never uses the accent colour", () => {
    for (const k of kinds) for (const q of stillPrims(k, true, ctx())) expect(q.cls).not.toMatch(/acc/);
  });
  it("errors add a jagged outline", () => {
    const a: Prim[] = [], b: Prim[] = [];
    draw("pump", 0.9, ctx(), false, 0, false, a);
    draw("pump", 0.9, ctx(), true, 0, false, b);
    expect(b.some((q) => q.cls === "a-jag")).toBe(true);
    expect(a.some((q) => q.cls === "a-jag")).toBe(false);
  });
  it("an idle engine returns the shared empty frame", () => {
    expect(new LaneActions().frame(1, NOW, ctxFor)).toBe(NONE);
  });
  it("still poses exist for every kind", () => {
    for (const k of kinds) expect(stillPrims(k, false, ctx()).length).toBeGreaterThan(0);
  });
});
