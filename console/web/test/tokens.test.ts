import { describe, expect, it } from "vitest";
import { emptySnapshot } from "../src/lib/reduce";
import { sanitizeSnapshot } from "../src/lib/sanitize";
import { isMetrics } from "../src/lib/guards";
import { fmtNum, tokensTip } from "../src/lib/format";

const base = {
  merged_total: 17, merged_24h: 3, merged_7d: 17, remaining: 58, throughput_per_h: 0.35, eta_h: null,
  success: {}, stage_median_min: {}, bottleneck: "build", tokens_today: { input: 15_000_000, output: 2_000_000, cache_read: 9 },
  rate_limited_1h: 0, eta: null, waste_per_productive_h_7d: null,
};
const total = { input: 62_340_511, output: 4_274_993, reasoning: 6_472_967, cache_read: 2_953_312_439, since: 1_791_459_632 };

describe("tokens_total", () => {
  it("passes guards and sanitize unchanged", () => {
    expect(isMetrics({ ...base, tokens_total: total })).toBe(true);
    const snap = sanitizeSnapshot({ ...emptySnapshot(), metrics: { ...base, tokens_total: total } }, emptySnapshot())!;
    expect(snap.metrics?.tokens_total).toEqual(total);
  });
  it("an older console without it loads with null", () => {
    expect(isMetrics(base)).toBe(true);
    const snap = sanitizeSnapshot({ ...emptySnapshot(), metrics: base }, emptySnapshot())!;
    expect(snap.metrics?.tokens_total).toBeNull();
  });
  it("a bad field is repaired, a missing since is null", () => {
    const snap = sanitizeSnapshot({ ...emptySnapshot(), metrics: { ...base, tokens_total: { input: "x", output: 2 } } }, emptySnapshot())!;
    expect(snap.metrics?.tokens_total).toEqual({ input: 0, output: 2, reasoning: 0, cache_read: 0, since: null });
  });
  it("fmtNum has billions", () => {
    expect(fmtNum(999_999_999)).toBe("1.0B");
    expect(fmtNum(999_400_000)).toBe("999M");
    expect(fmtNum(2_953_312_439)).toBe("3.0B");
    expect(fmtNum(12_500_000_000)).toBe("13B");
  });
  it("tooltip names the sum, the start date, today and what is left out", () => {
    const t = tokensTip(total, 17_000_000);
    // the start date is in the viewer's locale and zone, so only its year is pinned here
    expect(t).toMatch(/^total input \+ output since .*2026\n/);
    expect(t).toContain("input 62M · output 4.3M · today 17M");
    expect(t).toContain("not counted: reasoning 6.5M · cache read 3.0B");
    expect(tokensTip(null, 5)).toBe("tokens today: input + output");
  });
});
