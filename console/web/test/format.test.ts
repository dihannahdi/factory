import { describe, expect, it } from "vitest";
import { backoffDelay, cachePct, fmtAgo, fmtCountdown, fmtElapsed, fmtEta, fmtNum, safeUrl, shortModel, stripTag, truncate } from "../src/lib/format";
import { cells, moveBy, moveTo, toggle } from "../src/lib/models-order";
import { laneVM, lampOf, parseRatio } from "../src/lib/lanes";
import { emptySlot } from "../src/lib/reduce";

describe("elapsed / eta formatting", () => {
  it.each([[0, "0s"], [42, "42s"], [60, "1m00s"], [185, "3m05s"], [3599, "59m59s"], [3720, "1h02m"], [-5, "0s"]])("elapsed %s -> %s", (s, out) => expect(fmtElapsed(s)).toBe(out));
  it("elapsed of null is a dash", () => { expect(fmtElapsed(null)).toBe("—"); expect(fmtElapsed(NaN)).toBe("—"); });
  it.each([[null, "—"], [0.2, "12m"], [0.001, "1m"], [1, "1.0h"], [5.8, "5.8h"], [26, "26h"], [72, "3.0d"]])("eta %s -> %s", (h, out) => expect(fmtEta(h)).toBe(out));
  it("compact numbers", () => {
    expect(fmtNum(999)).toBe("999");
    expect(fmtNum(1500)).toBe("1.5k");
    expect(fmtNum(161234)).toBe("161k");
    expect(fmtNum(4011223)).toBe("4.0M");
    expect(fmtNum(null)).toBe("—");
  });
  it("cache percentage", () => {
    expect(cachePct({ input: 161234, cache_read: 4011223 })).toBe(96);
    expect(cachePct({ input: 0, cache_read: 0 })).toBe(0);
    expect(cachePct(null)).toBe(0);
  });
  it("countdown and ago", () => {
    expect(fmtCountdown(272)).toBe("4:32");
    expect(fmtCountdown(-3)).toBe("0:00");
    expect(fmtAgo(100, 130)).toBe("30s");
    expect(fmtAgo(0, 7200)).toBe("2h");
  });
  it("strings", () => {
    expect(shortModel("opencode/deepseek-v4.1-flash-free")).toBe("deepseek-v4.1-flash");
    expect(stripTag("[ELE-01] Tambahkan wiring")).toBe("Tambahkan wiring");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("https://github.com/x/y/pull/1")).toBe("https://github.com/x/y/pull/1");
  });
  it("reconnect backoff doubles and caps", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("power cell ordering", () => {
  const free = ["a", "b", "c", "d"].map((x) => ({ id: `opencode/${x}`, name: x, context: 1, output: 1, trains_on_data: x === "d" }));
  const ids = free.map((f) => f.id);
  it("selected first in fallback order, spares after, unknown ids dropped", () => {
    const c = cells(free, [ids[2], "opencode/ghost", ids[0]]);
    expect(c.map((x) => x.id)).toEqual([ids[2], ids[0], ids[1], ids[3]]);
    expect(c.map((x) => x.idx)).toEqual([1, 2, 0, 0]);
    expect(c[3].trains).toBe(true);
  });
  it("paid (Go) models join the rack; exposure follows trains/zero_retention", () => {
    const paid = [{ id: "opencode-go/deepseek-v4.1-flash", name: "DS", context: 1, output: 1, trains_on_data: false, zero_retention: true }];
    const fr = [
      { id: "opencode/z", name: "z", context: 1, output: 1, trains_on_data: false, zero_retention: true },
      { id: "opencode/k", name: "k", context: 1, output: 1, trains_on_data: false, zero_retention: false },
      { id: "opencode/u", name: "u", context: 1, output: 1, trains_on_data: null, zero_retention: null },
    ];
    const c = cells(fr, ["opencode-go/deepseek-v4.1-flash"], paid);
    expect(c.map((x) => x.id)).toEqual(["opencode-go/deepseek-v4.1-flash", "opencode/z", "opencode/k", "opencode/u"]);
    expect(c.map((x) => x.paid)).toEqual([true, false, false, false]);
    expect(c.map((x) => x.policy)).toEqual(["zero", "zero", "exposed", "unknown"]);
  });
  it("toggle never removes the last model and caps at five", () => {
    expect(toggle([ids[0]], ids[0])).toEqual([ids[0]]);
    expect(toggle([ids[0], ids[1]], ids[0])).toEqual([ids[1]]);
    expect(toggle([ids[0]], ids[1])).toEqual([ids[0], ids[1]]);
    expect(toggle(["1", "2", "3", "4", "5"], "6")).toEqual(["1", "2", "3", "4", "5"]);
  });
  it("move clamps", () => {
    expect(moveTo(ids, ids[0], 99)).toEqual([ids[1], ids[2], ids[3], ids[0]]);
    expect(moveBy(ids, ids[3], -1)).toEqual([ids[0], ids[1], ids[3], ids[2]]);
    expect(moveBy(ids, ids[0], -1)).toBe(ids);
  });
});

describe("lane view model", () => {
  it("parses sub-stages", () => {
    expect(parseRatio("complete 2/4", "complete")).toEqual({ r: 2, of: 4 });
    expect(parseRatio("fix 1/3", "fix")).toEqual({ r: 1, of: 3 });
    expect(parseRatio("steer", "fix")).toBeNull();
  });
  it("lamp states", () => {
    expect(lampOf({ name: "x", status: "completed", conclusion: "success" })).toBe("ok");
    expect(lampOf({ name: "x", status: "completed", conclusion: "failure" })).toBe("fail");
    expect(lampOf({ name: "x", status: "completed", conclusion: "skipped" })).toBe("off");
    expect(lampOf({ name: "x", status: "in_progress", conclusion: null })).toBe("run");
    expect(lampOf({ name: "x", status: "queued", conclusion: null })).toBe("wait");
  });
  it("elapsed ticks with now, verify failure and deferred stop are detected", () => {
    const s = { ...emptySlot(1), state: "running" as const, run_id: "r", stage: "verify" as const, sub: "fix 1/3", stage_started: 100, updated: 500, issue: { n: 1, title: "t", tag: "X-1", family: "X", url: "u" } };
    expect(laneVM(s, 160).elapsed).toBe(60);
    expect(laneVM(s, 160).verifyFailing).toBe(true);
    expect(laneVM({ ...s, stage: "merge", sub: "stop deferred" }, 160).deferred).toBe(true);
    expect(laneVM(s, 700).stale).toBe(true);
    expect(laneVM(emptySlot(2), 1).dormant).toBe(true);
  });
});
