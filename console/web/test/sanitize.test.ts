import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { emptySnapshot } from "../src/lib/reduce";
import { sanitizeEvent, sanitizeSlot, sanitizeSnapshot } from "../src/lib/sanitize";
import { isSlot } from "../src/lib/guards";
import { laneVM } from "../src/lib/lanes";
import type { Snapshot } from "../src/lib/types";

const FIX = path.resolve(__dirname, "../../../contracts/fixtures");
const json = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const prev = (): Snapshot => emptySnapshot();

describe("live snapshot captured from production", () => {
  const live = json("live/state.json");
  const snap = sanitizeSnapshot(live, prev())!;
  it("parses", () => expect(snap).not.toBeNull());
  it("renders 1 idle lane and 2 parked", () => {
    const vms = snap.slots.map((s) => laneVM(s, snap.now));
    expect(snap.slots.map((s) => s.state)).toEqual(["idle", "parked", "parked"]);
    expect(vms.map((v) => v.dormant)).toEqual([false, true, true]);
    expect(vms[0].hasIssue).toBe(false);
  });
  it("shows metrics", () => {
    expect(snap.metrics?.merged_7d).toBe(1);
    expect(typeof snap.metrics?.merged_total).toBe("number");
    expect(snap.metrics?.remaining).toBe(65);
    expect(snap.metrics?.eta_h).toBeNull();
  });
  it("shows the Recent row (#26 waiting)", () => {
    expect(snap.recent[0]).toMatchObject({ issue: 26, outcome: "waiting", url: null });
  });
  it("keeps github, models (12 free) and lane 1 activity", () => {
    expect(snap.github?.issues.length).toBe(80);
    expect(snap.models?.free.length).toBeGreaterThanOrEqual(12);
    expect(snap.activity["1"].length).toBeGreaterThan(0);
  });
});

describe("one bad part never drops the rest", () => {
  const live = json("live/state.json");
  it("slot with updated: null is accepted as updated 0", () => {
    const s = sanitizeSlot({ ...live.slots[1], updated: null }, 2);
    expect(s.updated).toBe(0);
    expect(isSlot(s)).toBe(true);
  });
  it("a garbage slot becomes a blank parked slot for that number", () => {
    const s = sanitizeSlot({ slot: 3, state: "exploding" }, 3);
    expect(s.slot).toBe(3);
    expect(s.state).toBe("parked");
  });
  it("snapshot with a broken slot, a broken github and a broken metrics keeps everything else", () => {
    const bad = { ...live, slots: [live.slots[0], "nope", { slot: 3, state: 7 }], github: 42, metrics: "x", recent: [{ ts: 1, issue: 2, slot: 1, outcome: "merged" }, { junk: 1 }] };
    const base = prev();
    const out = sanitizeSnapshot(bad, base)!;
    expect(out.slots.map((s) => s.state)).toEqual(["idle", "parked", "parked"]);
    expect(out.github).toBe(base.github); // fell back to the previous value
    expect(out.metrics).toBe(base.metrics);
    expect(out.control.agents).toBe(1);
    expect(out.models?.free.length).toBeGreaterThan(0);
    expect(out.recent).toHaveLength(1);
  });
  it("github with a few bad issues keeps the good ones", () => {
    const g = { ...live.github, issues: [live.github.issues[0], { n: "x" }, live.github.issues[1]] };
    const out = sanitizeEvent("github", g, prev());
    expect(out.ok && (out.value as { issues: unknown[] }).issues).toHaveLength(2);
  });
  it("only a non-object snapshot is rejected", () => {
    expect(sanitizeSnapshot("x", prev())).toBeNull();
    expect(sanitizeSnapshot([], prev())).toBeNull();
    expect(sanitizeSnapshot({}, prev())).not.toBeNull();
  });
  it("events: a bad slot event becomes a parked slot, an unknown key is dropped, null halt clears", () => {
    const e = sanitizeEvent("slot", { slot: 2, state: "???" }, prev());
    expect(e.ok && (e.value as { state: string }).state).toBe("parked");
    expect(sanitizeEvent("slot", { slot: 9 }, prev()).ok).toBe(false);
    expect(sanitizeEvent("bogus", {}, prev()).ok).toBe(false);
    expect(sanitizeEvent("halt", null, prev())).toEqual({ ok: true, value: null });
    expect(sanitizeEvent("activity", { slot: 1, items: [{ t: 1, kind: "tool" }, { bad: 1 }] }, prev()).ok).toBe(true);
  });
});
