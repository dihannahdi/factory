import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { apply, emptySnapshot, strokesIn } from "../src/lib/reduce";
import type { Item, Slot, Snapshot } from "../src/lib/types";

const FIX = path.resolve(__dirname, "../../../contracts/fixtures");
const json = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const item = (n: number, kind: Item["kind"] = "tool"): Item => ({ t: n, kind, tool: "bash", target: `cmd ${n}` });
const base = (): Snapshot => ({ ...emptySnapshot(), now: 1 });

describe("reducer", () => {
  it("snapshot replaces everything and guarantees three activity keys", () => {
    const s = apply(base(), "snapshot", { ...base(), now: 99, activity: { "1": [item(1)] } });
    expect(s.now).toBe(99);
    expect(s.activity["1"]).toHaveLength(1);
    expect(s.activity["3"]).toEqual([]);
  });
  it("slot replaces slots[slot-1] only", () => {
    const s1: Slot = json("ui/slots/1.json");
    const out = apply(base(), "slot", s1);
    expect(out.slots[0].issue?.tag).toBe("ELE-01");
    expect(out.slots[1].state).toBe("parked");
  });
  it("slot with an out-of-range number is ignored", () => {
    const snap = base();
    expect(apply(snap, "slot", { ...json("ui/slots/1.json"), slot: 7 })).toBe(snap);
  });
  it("activity appends and keeps the last 50", () => {
    let s = base();
    s = apply(s, "activity", { slot: 2, items: Array.from({ length: 40 }, (_, i) => item(i)) });
    s = apply(s, "activity", { slot: 2, items: Array.from({ length: 30 }, (_, i) => item(100 + i)) });
    expect(s.activity["2"]).toHaveLength(50);
    expect(s.activity["2"][49].t).toBe(129);
    expect(s.activity["2"][0].t).toBe(20);
    expect(s.activity["1"]).toEqual([]);
  });
  it("activity with reset replaces", () => {
    let s = apply(base(), "activity", { slot: 1, items: [item(1), item(2)] });
    s = apply(s, "activity", { slot: 1, items: [item(9)], reset: true });
    expect(s.activity["1"].map((i) => i.t)).toEqual([9]);
  });
  it.each([
    ["control", json("ctl/control.json"), "control"],
    ["github", json("ui/github.json"), "github"],
    ["models", json("ui/models.json"), "models"],
    ["metrics", { merged_24h: 3 }, "metrics"],
    ["halt", json("ui/halt.example.json"), "halt"],
    ["recent", [{ ts: 1, issue: 2, slot: 1, outcome: "merged" }], "recent"],
    ["consumed", { "5": "x" }, "consumed"],
  ] as const)("%s replaces its key and nothing else", (key, data, field) => {
    const before = base();
    const after = apply(before, key, data) as unknown as Record<string, unknown>;
    expect(after[field]).toBe(data);
    expect(after.slots).toBe(before.slots);
  });
  it("halt can be cleared with null", () => {
    const h = apply(base(), "halt", json("ui/halt.example.json"));
    expect(apply(h, "halt", null).halt).toBeNull();
  });
  it("unknown keys are a no-op and the input is never mutated", () => {
    const before = base();
    const frozen = JSON.stringify(before);
    expect(apply(before, "bogus", 1)).toBe(before);
    apply(before, "control", { agents: 3 });
    expect(JSON.stringify(before)).toBe(frozen);
  });
  it("counts only tool items as press strokes", () => {
    expect(strokesIn([item(1), item(2, "text"), item(3), item(4, "step")])).toBe(2);
  });
});
