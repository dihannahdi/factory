import { describe, expect, it } from "vitest";
import { TOUR_DWELL_MS, TOUR_PAUSE_MS, TOUR_PULL_EVERY_MS, TOUR_PULL_MS, freshestLane, newTourMem, tourStep } from "../src/lib/camera.svelte";
import type { TourIn } from "../src/lib/camera.svelte";
import { makeLimiter, soundFor, humHz, setOn, play, hasContext } from "../src/lib/sound";

const base = (o: Partial<TourIn> = {}): TourIn => ({ now: 1000, active: [true, true, false], lastTool: [500, 900, 0], reduced: false, manualAt: -1e12, ...o });

describe("freshestLane", () => {
  it("picks the active lane with the latest tool event", () => {
    expect(freshestLane([true, true, true], [10, 30, 20])).toBe(1);
    expect(freshestLane([true, false, true], [10, 30, 20])).toBe(2);
    expect(freshestLane([false, false, false], [1, 2, 3])).toBe(-1);
    expect(freshestLane([true, true, false], [0, 0, 0])).toBe(0);
  });
});

describe("tourStep", () => {
  it("starts on the freshest lane", () => {
    const m = newTourMem(1000);
    expect(tourStep(m, base())).toEqual({ kind: "follow", lane: 1 });
  });
  it("holds the lane for the minimum dwell even when another is fresher", () => {
    const m = newTourMem(1000);
    tourStep(m, base());
    const a = tourStep(m, base({ now: 1000 + TOUR_DWELL_MS - 1, lastTool: [9999, 900, 0] }));
    expect(a).toEqual({ kind: "follow", lane: 1 });
    const b = tourStep(m, base({ now: 1000 + TOUR_DWELL_MS, lastTool: [9999, 900, 0] }));
    expect(b).toEqual({ kind: "follow", lane: 0 });
  });
  it("does not switch to a lane that is not fresher", () => {
    const m = newTourMem(1000);
    tourStep(m, base());
    expect(tourStep(m, base({ now: 1000 + TOUR_DWELL_MS * 2, lastTool: [100, 900, 0] }))).toEqual({ kind: "follow", lane: 1 });
  });
  it("leaves a lane at once when it stops being active", () => {
    const m = newTourMem(1000);
    tourStep(m, base());
    expect(tourStep(m, base({ now: 1100, active: [true, false, false] }))).toEqual({ kind: "follow", lane: 0 });
  });
  it("fits the whole machine when nothing runs", () => {
    expect(tourStep(newTourMem(0), base({ active: [false, false, false] }))).toEqual({ kind: "fit" });
  });
  it("pulls back every 45 s for 4 s, then returns to following", () => {
    const m = newTourMem(0);
    tourStep(m, base({ now: 10 }));
    expect(tourStep(m, base({ now: TOUR_PULL_EVERY_MS + 1 })).kind).toBe("fit");
    expect(tourStep(m, base({ now: TOUR_PULL_EVERY_MS + TOUR_PULL_MS - 1 })).kind).toBe("fit");
    expect(tourStep(m, base({ now: TOUR_PULL_EVERY_MS + TOUR_PULL_MS + 1 })).kind).toBe("follow");
    expect(tourStep(m, base({ now: TOUR_PULL_EVERY_MS + TOUR_PULL_MS + 2000 })).kind).toBe("follow");
  });
  it("reduced motion: no pull-back", () => {
    const m = newTourMem(0);
    expect(tourStep(m, base({ now: TOUR_PULL_EVERY_MS + 1, reduced: true })).kind).toBe("follow");
  });
  it("a manual move pauses the tour for 15 s, then it resumes with a fresh pick", () => {
    const m = newTourMem(0);
    tourStep(m, base({ now: 100 }));
    expect(tourStep(m, base({ now: 5000, manualAt: 4000 })).kind).toBe("idle");
    expect(tourStep(m, base({ now: 4000 + TOUR_PAUSE_MS - 1, manualAt: 4000 })).kind).toBe("idle");
    expect(tourStep(m, base({ now: 4000 + TOUR_PAUSE_MS, manualAt: 4000 }))).toEqual({ kind: "follow", lane: 1 });
  });
});

describe("sound helpers", () => {
  it("maps tools to sounds", () => {
    expect(soundFor({ kind: "tool", tool: "edit", target: "a.rs" })).toBe("thunk");
    expect(soundFor({ kind: "tool", tool: "write", target: "a.rs" })).toBe("thunk");
    expect(soundFor({ kind: "tool", tool: "read", target: "a.rs" })).toBe("paper");
    expect(soundFor({ kind: "tool", tool: "grep", target: "x" })).toBe("tick");
    expect(soundFor({ kind: "tool", tool: "glob", target: "x" })).toBe("tick");
    expect(soundFor({ kind: "tool", tool: "bash", target: "cargo test -p shop-core" })).toBe("bubbles");
    expect(soundFor({ kind: "tool", tool: "bash", target: "ls -la" })).toBe("tick");
    expect(soundFor({ kind: "text", tool: null, target: null })).toBeNull();
    expect(soundFor({ kind: "tool", tool: "todowrite", target: "" })).toBeNull();
  });
  it("limits bursts to 8 per second", () => {
    const ok = makeLimiter(8);
    const got = Array.from({ length: 20 }, (_, i) => ok(1000 + i * 10)).filter(Boolean).length;
    expect(got).toBe(8);
    expect(ok(2100)).toBe(true);
  });
  it("hum pitch rises with tokens/min and is bounded", () => {
    expect(humHz(0)).toBe(48);
    expect(humHz(30000)).toBeGreaterThan(humHz(1000));
    expect(humHz(1e9)).toBe(110);
  });
  it("never throws and creates no AudioContext without WebAudio or a gesture", () => {
    expect(() => { setOn(true); play("thunk"); play("gong"); }).not.toThrow();
    expect(hasContext()).toBe(false);
    setOn(false);
  });
});
