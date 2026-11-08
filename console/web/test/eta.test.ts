import { describe, expect, it } from "vitest";
import { emptySnapshot } from "../src/lib/reduce";
import { sanitizeEvent, sanitizeSnapshot } from "../src/lib/sanitize";
import { etaInfo, isMetrics } from "../src/lib/guards";
import { etaTip, fmtEtaRange, fmtWaste } from "../src/lib/format";
import type { EtaInfo } from "../src/lib/types";

const eta = (over: Partial<EtaInfo> = {}): EtaInfo => ({
  p50_h: 95, p80_h: 169, lanes: 3, rate_per_lane_h: 0.201, merges_per_issue: 1.063, doable: 54,
  waiting_human: [{ n: 53, tag: "ENG-41" }, { n: 98, tag: null }],
  size_model: { active: false, feature: null, n: 13, flat_mae: 1.3, mae: null },
  q_effort: 1.159, q_rate: 1.262, dispersion: 1, ...over,
});
const metrics = (extra: Record<string, unknown> = {}) => ({
  merged_total: 17, merged_24h: 3, merged_7d: 17, remaining: 58, throughput_per_h: 0.35, eta_h: 95,
  success: {}, stage_median_min: {}, bottleneck: "build", tokens_today: { input: 1, output: 2, cache_read: 3 },
  rate_limited_1h: 0, eta: eta(), waste_per_productive_h_7d: 0.8, ...extra,
});

describe("ETA tile formatting", () => {
  it.each([
    [95, 169, "4–7 days"], [95, null, "4 days"], [95, 100, "4 days"], [30, 38, "30–38 h"], [30, null, "30 h"],
    [0.4, 0.9, "24 min"], [47.9, 60, "48–60 h"], [48, 72, "2–3 days"], [null, null, "—"],
  ])("p50 %s p80 %s -> %s", (a, b, out) => expect(fmtEtaRange(a, b)).toBe(out));
  it("waste has one decimal", () => {
    expect(fmtWaste(0.8)).toBe("0.8"); expect(fmtWaste(0.39)).toBe("0.4"); expect(fmtWaste(0)).toBe("0.0");
    expect(fmtWaste(null)).toBe("—");
  });
  it("tooltip names P50/P80, scope, rate, lanes and the size state", () => {
    const t = etaTip({ eta: eta() });
    expect(t).toContain("P50 95.0 h");
    expect(t).toContain("P80 169.0 h");
    expect(t).toContain("54 issues");
    expect(t).toContain("ENG-41 #98");
    expect(t).toContain("0.201");
    expect(t).toContain("× 3 lanes");
    expect(t).toContain("size: average (n=13/30)");
    expect(etaTip({ eta: eta({ size_model: { active: true, feature: "bullets", n: 41, flat_mae: 1.4, mae: 1 } }) })).toContain("size: bullets (n=41)");
    expect(etaTip({ eta: eta({ p80_h: null }) })).toContain("P80 —");
    expect(t).toContain("P80 ×1.26: rate still uncertain (daily dispersion 1.0)");
    expect(etaTip({ eta: eta({ q_effort: 1.8, q_rate: 1.3 }) })).toContain("P80 ×1.80: issue sizes are uneven");
    expect(etaTip({ eta: eta({ dispersion: null }) })).toContain("P80 ×1.26: rate still uncertain (daily dispersion not measured yet)");
    expect(etaTip({ eta: eta({ q_effort: null, q_rate: null, dispersion: null }) })).not.toContain("P80 ×");
    expect(etaTip({ eta: null })).toContain("≥ 3 merges");
  });
});

describe("new metrics fields through guards and sanitize", () => {
  it("accepts a full payload and keeps eta intact", () => {
    expect(isMetrics(metrics())).toBe(true);
    expect(etaInfo(eta())).toBe(true);
    const snap = sanitizeSnapshot({ ...emptySnapshot(), metrics: metrics() }, emptySnapshot())!;
    expect(snap.metrics?.eta).toEqual(eta());
    expect(snap.metrics?.waste_per_productive_h_7d).toBe(0.8);
    expect(snap.metrics?.eta_h).toBe(95);
  });
  it("an older console without the fields still loads, with null defaults", () => {
    const old: Record<string, unknown> = metrics();
    delete old.eta; delete old.waste_per_productive_h_7d;
    expect(isMetrics(old)).toBe(true);
    const snap = sanitizeSnapshot({ ...emptySnapshot(), metrics: old }, emptySnapshot())!;
    expect(snap.metrics?.eta).toBeNull();
    expect(snap.metrics?.waste_per_productive_h_7d).toBeNull();
  });
  it("null eta and null waste are valid (no estimate yet)", () => {
    const m = metrics({ eta: null, eta_h: null, waste_per_productive_h_7d: null });
    expect(isMetrics(m)).toBe(true);
    const e = sanitizeEvent("metrics", m, emptySnapshot());
    expect(e.ok).toBe(true);
  });
  it("a half-shaped eta is dropped, the rest of the metrics survive", () => {
    const snap = sanitizeSnapshot({ ...emptySnapshot(), metrics: metrics({ eta: { p50_h: "soon" }, waste_per_productive_h_7d: "lots" }) }, emptySnapshot())!;
    expect(snap.metrics?.eta).toBeNull();
    expect(snap.metrics?.waste_per_productive_h_7d).toBeNull();
    expect(snap.metrics?.merged_total).toBe(17);
  });
  it("an eta without the P80 factors (older console) loads with nulls", () => {
    const e = eta() as unknown as Record<string, unknown>;
    delete e.q_effort; delete e.q_rate; delete e.dispersion;
    const snap = sanitizeSnapshot({ ...emptySnapshot(), metrics: metrics({ eta: e }) }, emptySnapshot())!;
    expect(snap.metrics?.eta).toMatchObject({ q_effort: null, q_rate: null, dispersion: null, p50_h: 95 });
  });
  it("missing size_model and bad waiting_human entries are repaired", () => {
    const e = eta() as unknown as Record<string, unknown>;
    delete e.size_model;
    e.waiting_human = [{ n: 1, tag: "A" }, { n: "x" }, null, { n: 2, tag: null }];
    const snap = sanitizeSnapshot({ ...emptySnapshot(), metrics: metrics({ eta: e }) }, emptySnapshot())!;
    expect(snap.metrics?.eta?.waiting_human).toEqual([{ n: 1, tag: "A" }, { n: 2, tag: null }]);
    expect(snap.metrics?.eta?.size_model).toEqual({ active: false, feature: null, n: 0, flat_mae: null, mae: null });
  });
});
