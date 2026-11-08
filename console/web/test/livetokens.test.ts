import { describe, expect, it } from "vitest";
import { CountUp, accumulate, flySpeed, liveOf, newAcc, sumWindow, turnKey } from "../src/lib/livetokens.svelte";
import type { Item } from "../src/lib/types";

const step = (t: number, i: number, o: number): Item => ({ t, kind: "step", tokens: { in: i, out: o } });
const tool = (t: number): Item => ({ t, kind: "tool", tool: "bash", target: "ls" });
const NOW = 1_800_000_000_000;

describe("live tokens", () => {
  it("adds the running turn's steps on top of slot.tokens", () => {
    const a = newAcc();
    accumulate(a, "r|e|1", NOW - 10_000, [tool(NOW - 9000), step(NOW - 8000, 1000, 200), step(NOW - 4000, 500, 50)], NOW);
    expect(liveOf({ input: 161234, output: 21877, cache_read: 0 }, a)).toEqual({ input: 162734, output: 22127 });
  });
  it("a lane with no tokens yet still counts up from zero", () => {
    const a = newAcc();
    accumulate(a, "r|e|1", NOW - 5000, [step(NOW - 1000, 700, 30)], NOW);
    expect(liveOf(null, a)).toEqual({ input: 700, output: 30 });
  });
  it("ignores steps from before the turn started", () => {
    const a = newAcc();
    accumulate(a, "r|e|1", NOW - 5000, [step(NOW - 20_000, 9000, 900), step(NOW - 1000, 10, 1)], NOW);
    expect(liveOf(null, a)).toEqual({ input: 10, output: 1 });
  });
  it("dedupes by t across repeated and overlapping feeds", () => {
    const a = newAcc();
    const s1 = step(NOW - 3000, 100, 10);
    accumulate(a, "k", NOW - 9000, [s1], NOW);
    accumulate(a, "k", NOW - 9000, [s1, step(NOW - 3000, 100, 10)], NOW); // same t again
    accumulate(a, "k", NOW - 9000, [s1, step(NOW - 2000, 5, 1)], NOW);
    expect(liveOf(null, a)).toEqual({ input: 105, output: 11 });
  });
  it("keeps the sum when old steps scroll out of the 50-item window", () => {
    const a = newAcc();
    accumulate(a, "k", NOW - 60_000, [step(NOW - 50_000, 100, 10)], NOW);
    accumulate(a, "k", NOW - 60_000, [tool(NOW - 1000)], NOW);
    expect(liveOf(null, a)).toEqual({ input: 100, output: 10 });
  });
  it("resets when the turn or run changes", () => {
    const a = newAcc();
    accumulate(a, "k1", NOW - 9000, [step(NOW - 3000, 100, 10)], NOW);
    accumulate(a, "k2", NOW - 1000, [step(NOW - 3000, 100, 10)], NOW); // before the new turn started: not counted
    expect(liveOf(null, a)).toEqual({ input: 0, output: 0 });
    accumulate(a, "k2", NOW - 1000, [step(NOW - 500, 7, 3)], NOW);
    expect(liveOf(null, a)).toEqual({ input: 7, output: 3 });
  });
  it("no turn: only slot.tokens", () => {
    const a = newAcc();
    accumulate(a, "", 0, [step(NOW - 1000, 100, 10)], NOW);
    expect(liveOf({ input: 5, output: 6, cache_read: 0 }, a)).toEqual({ input: 5, output: 6 });
  });
  it("turn key changes with run, events file and start", () => {
    const base = { run_id: "a", turn: { phase: "plan", started: 1, events: "/x/plan-0.jsonl" } };
    expect(turnKey(base)).not.toBe(turnKey({ ...base, run_id: "b" }));
    expect(turnKey(base)).not.toBe(turnKey({ ...base, turn: { ...base.turn, started: 2 } }));
    expect(turnKey({ run_id: "a", turn: null })).toBe("");
  });
});

describe("tokens per minute", () => {
  it("sums the last 60 s of steps across lanes", () => {
    const a = newAcc(), b = newAcc();
    accumulate(a, "k", NOW - 100_000, [step(NOW - 90_000, 1000, 0), step(NOW - 30_000, 600, 400)], NOW);
    accumulate(b, "j", NOW - 100_000, [step(NOW - 10_000, 300, 100)], NOW);
    expect(sumWindow([a, b], NOW)).toBe(1000 + 400);
  });
  it("prunes the log and lets pruned timestamps go", () => {
    const a = newAcc();
    accumulate(a, "k", NOW - 500_000, [step(NOW - 119_000, 10, 0)], NOW);
    expect(a.log.length).toBe(1);
    accumulate(a, "k", NOW - 500_000, [step(NOW - 119_000, 10, 0)], NOW + 5000);
    expect(a.log.length).toBe(0);
    expect(a.logSeen.size).toBe(0);
  });
  it("flywheel speed rises with tokens/min and is capped; idle breathes", () => {
    expect(flySpeed(false, 999_999)).toBe(0.12);
    expect(flySpeed(true, 0)).toBeCloseTo(0.6);
    expect(flySpeed(true, 60_000)).toBeCloseTo(5.6);
    expect(flySpeed(true, 10_000_000)).toBeCloseTo(9.6);
  });
});

describe("count-up", () => {
  it("starts at the first value, eases to a new one, and settles", () => {
    let t = 0;
    const c = new CountUp();
    expect(c.read(100, () => t, false)).toBe(100);
    expect(c.read(300, () => t, false)).toBe(100); // tween begins at t=0
    t = 0.25;
    const mid = c.read(300, () => t, false);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(300);
    t = 0.6;
    expect(c.read(300, () => t, false)).toBe(300);
  });
  it("is instant under reduced motion", () => {
    const c = new CountUp();
    c.read(10, () => 0, true);
    expect(c.read(999, () => 0, true)).toBe(999);
  });
  it("does not touch the clock once settled", () => {
    let reads = 0;
    const c = new CountUp();
    c.read(5, () => (reads++, 0), false);
    c.read(5, () => (reads++, 0), false);
    expect(reads).toBe(0);
  });
});
