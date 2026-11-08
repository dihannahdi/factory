import { describe, expect, it } from "vitest";
import { advance, frameAt, itemsIn, normalizeDetail, recordedDelta, segments, stageAt, turnAt } from "../src/lib/replay.svelte";
import { heldByReplay, holdLane, store } from "../src/lib/store.svelte";
import { emptySlot, emptySnapshot } from "../src/lib/reduce";

const T0 = 1_792_129_717_000;
const raw = {
  id: "issue-24-20261016T055517Z-s2", issue: 24, tag: "ELE-01", title: "Wiring", slot: 2, outcome: "merged", url: "https://github.com/x/y/pull/136",
  started: T0 / 1000, ended: T0 / 1000 + 100,
  items: [
    { t: T0 + 10_000, phase: "plan", kind: "tool", tool: "read", target: "a.rs", text: null, status: "completed", tokens: null },
    { t: T0 + 12_000, phase: "plan", kind: "step", tokens: { in: 100, out: 20 } },
    { t: T0 + 40_000, phase: "build", kind: "tool", tool: "edit", target: "b.rs", text: null, status: "completed", tokens: null },
    { t: T0 + 41_000, phase: "build", kind: "tool", tool: "bash", target: "cargo test", text: null, status: "completed", tokens: null },
    { t: 5, kind: "bogus" },
  ],
  timeline: [{ t: T0 + 30_000, stage: "build" }, { t: T0, stage: "plan" }, { t: T0 + 90_000, stage: "pr" }, { t: T0 + 95_000, stage: "nonsense" }],
};
const d = normalizeDetail(raw)!;

describe("normalizeDetail", () => {
  it("sorts, drops bad rows, derives bounds and slot", () => {
    expect(d.items).toHaveLength(4);
    expect(d.timeline.map((e) => e.stage)).toEqual(["plan", "build", "pr"]);
    expect(d.t0).toBe(T0);
    expect(d.t1).toBe(T0 + 100_000);
    expect(d.slot).toBe(2);
  });
  it("falls back to the slot in the id and rejects non-runs", () => {
    expect(normalizeDetail({ id: "issue-1-20261016T055517Z-s3", items: [{ t: 1, kind: "text" }], timeline: [] })!.slot).toBe(3);
    expect(normalizeDetail(null)).toBeNull();
    expect(normalizeDetail({ id: "x", items: [], timeline: [] })).toBeNull();
  });
});

describe("scheduler", () => {
  it("stage follows the timeline", () => {
    expect(stageAt(d.timeline, T0 - 5)).toBe("plan");
    expect(stageAt(d.timeline, T0 + 29_999)).toBe("plan");
    expect(stageAt(d.timeline, T0 + 30_000)).toBe("build");
    expect(stageAt(d.timeline, T0 + 99_000)).toBe("pr");
  });
  it("items between two times are half-open (a, b]", () => {
    expect(itemsIn(d.items, T0, T0 + 10_000).map((i) => i.tool)).toEqual(["read"]);
    expect(itemsIn(d.items, T0 + 10_000, T0 + 12_000)).toHaveLength(1);
    expect(itemsIn(d.items, T0 + 10_000, T0 + 12_000)[0].kind).toBe("step");
    expect(itemsIn(d.items, T0 + 12_000, T0 + 39_000)).toHaveLength(0);
  });
  it("a turn runs while its phase items flow and lingers 4 s", () => {
    expect(turnAt(d.items, T0 + 5000)).toBeNull();
    expect(turnAt(d.items, T0 + 11_000)?.phase).toBe("plan");
    expect(turnAt(d.items, T0 + 16_000)?.phase).toBe("plan");
    expect(turnAt(d.items, T0 + 17_000)).toBeNull();
    expect(turnAt(d.items, T0 + 41_500)?.phase).toBe("build");
  });
  it("speed maps real time to recorded time", () => {
    expect(recordedDelta(1000, 30)).toBe(30_000);
    const from = T0 + 10_000, to = from + recordedDelta(1000, 30);
    const s = advance(d, from, to, 1000);
    expect(s.items.map((i) => i.kind)).toEqual(["step", "tool"]);
    expect(s.slot.stage).toBe("build");
    expect(s.reset).toBe(false);
  });
  it("seeking backwards resets the activity to everything up to t", () => {
    const s = advance(d, T0 + 50_000, T0 + 11_000, 1000);
    expect(s.reset).toBe(true);
    expect(s.items).toHaveLength(1);
    expect(s.slot.stage).toBe("plan");
  });
  it("the synthesised slot is a well-formed running slot on the recorded lane", () => {
    const f = frameAt(d, T0 + 41_500, 2000).slot;
    expect(f.slot).toBe(2);
    expect(f.state).toBe("running");
    expect(f.issue?.n).toBe(24);
    expect(f.turn?.phase).toBe("build");
    expect(f.tokens).toMatchObject({ input: 100, output: 20 });
    expect(f.stage_started).toBe(2000 - 12);
    expect(f.pr).toBeNull();
    expect(frameAt(d, T0 + 95_000, 2000).slot.pr?.n).toBe(136);
  });
  it("segments tile the run", () => {
    const sg = segments(d);
    expect(sg[0].a).toBe(0);
    expect(sg.at(-1)!.b).toBe(1);
  });
});

describe("store gate", () => {
  it("holds slot and activity events of the replayed lane only", () => {
    expect(heldByReplay("slot", { slot: 2 }, 2)).toBe(true);
    expect(heldByReplay("activity", { slot: 2, items: [] }, 2)).toBe(true);
    expect(heldByReplay("slot", { slot: 1 }, 2)).toBe(false);
    expect(heldByReplay("control", { slot: 2 }, 2)).toBe(false);
    expect(heldByReplay("slot", { slot: 2 }, null)).toBe(false);
  });
  it("a snapshot keeps the held lane's slot and activity", () => {
    const cur = emptySnapshot();
    cur.slots[1] = { ...emptySlot(2), run_id: "replay-x", state: "running" };
    cur.activity["2"] = [{ t: 1, kind: "text", text: "r" }];
    const next = emptySnapshot();
    const out = holdLane(next, cur, 2);
    expect(out.slots[1].run_id).toBe("replay-x");
    expect(out.activity["2"]).toHaveLength(1);
    expect(out.slots[0]).toBe(next.slots[0]);
  });
  it("ingest of a snapshot honours store.replayLane", () => {
    store.replayLane = null;
    store.ingest("slot", { ...emptySlot(2), run_id: "replay-x", state: "running" });
    store.replayLane = 2;
    store.ingest("snapshot", emptySnapshot());
    expect(store.snap.slots[1].run_id).toBe("replay-x");
    store.replayLane = null;
    store.ingest("snapshot", emptySnapshot());
    expect(store.snap.slots[1].run_id).toBeNull();
  });
});
