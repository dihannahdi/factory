import { describe, expect, it } from "vitest";
import { buildDepMap, chainOf, whyText } from "../src/lib/depmap";
import type { GhDone, GhIssue, IssueClass } from "../src/lib/types";

const iss = (n: number, cls: IssueClass, deps: number[] = [], milestone = "M2 Feature parity"): GhIssue => ({
  n, title: `[T-${n}] title ${n}`, tag: `T-${n}`, family: "T", milestone, priority: "P1", labels: [], class: cls,
  reason: cls === "failed" ? "label agent-failed" : "", deps, taken_by: [], claimed_by: null, order: null, url: `https://x/${n}`,
});

// The live shape of 2026-10-18: #23 <-> #58 cycle, #26 under it, a failed root, a plain chain, a bare label.
const live = [
  iss(22, "running"),
  iss(23, "blocked", [58]), iss(58, "blocked", [23, 29]), iss(29, "eligible"), iss(26, "blocked", [23]),
  iss(31, "eligible"), iss(30, "blocked", [31]), iss(33, "blocked", [30, 31]),
  iss(18, "failed"), iss(21, "blocked", [18]),
  iss(99, "blocked", []),
  iss(7, "eligible"), iss(8, "queued"),
  iss(40, "blocked", [404, 40]), // a dep that is not open, and itself: both ignored
];

describe("dependency map", () => {
  const m = buildDepMap(live);
  const at = (n: number) => [...m.nodes, ...m.free].find((x) => x.n === n)!;

  it("states: cycle, stuck under a cycle or a human root, waiting on agent work, ready, human", () => {
    expect([23, 58].map((n) => at(n).state)).toEqual(["cycle", "cycle"]);
    expect(at(26).state).toBe("stuck");
    expect(at(21).state).toBe("stuck");
    expect(at(18).state).toBe("human");
    expect(at(30).state).toBe("waiting");
    expect(at(33).state).toBe("waiting");
    expect(at(31).state).toBe("ready");
    expect(at(29).state).toBe("ready");
    expect(at(22).state).toBe("running");
    expect(at(99).state).toBe("stuck"); // agent-blocked label with nothing open under it
    expect(at(8).state).toBe("ready");
  });

  it("cycles are found once, sorted", () => {
    expect(m.cycles).toEqual([[23, 58]]);
    expect(m.edges.filter((e) => e.cycle).map((e) => `${e.from}>${e.to}`).sort()).toEqual(["23>58", "58>23"]);
  });

  it("only linked issues are drawn; the rest is the free list", () => {
    expect(m.nodes.map((x) => x.n).sort((a, b) => a - b)).toEqual([18, 21, 23, 26, 29, 30, 31, 33, 58]);
    expect(m.free.map((x) => x.n)).toEqual([7, 8, 22, 40, 99]);
    expect(at(40).deps).toEqual([]);
  });

  it("layers follow the longest open chain; a cycle shares one layer", () => {
    expect(at(31).rank).toBe(0);
    expect(at(30).rank).toBe(1);
    expect(at(33).rank).toBe(2);
    expect(at(29).rank).toBe(0);
    expect(at(23).rank).toBe(at(58).rank);
    expect(at(23).rank).toBe(1);
    expect(at(26).rank).toBe(2);
    expect(m.layers).toBe(3);
  });

  it("unblocks counts every issue above, through the cycle too", () => {
    expect(at(31).unblocks).toBe(2); // 30, 33
    expect(at(29).unblocks).toBe(3); // 58, 23, 26
    expect(at(18).unblocks).toBe(1);
    expect(chainOf(m, 26).up).toEqual(new Set([23, 58, 29]));
  });

  it("summary covers drawn and free issues", () => {
    // #40 waits only for a closed issue and itself: nothing open is left, so its label needs a human
    expect(at(40).state).toBe("stuck");
    expect(m.summary).toEqual({ running: 1, ready: 4, waiting: 2, stuck: 4, human: 1, cycle: 2, done: 0 });
  });

  it("is deterministic regardless of input order", () => {
    const a = buildDepMap(live), b = buildDepMap([...live].reverse());
    const key = (d: typeof a) => d.nodes.map((x) => `${x.n}@${x.rank}.${x.pos}`).sort().join(" ");
    expect(key(b)).toBe(key(a));
  });

  it("positions inside a layer are a permutation 0..k-1", () => {
    for (let r = 0; r < m.layers; r++) {
      const ps = m.nodes.filter((x) => x.rank === r).map((x) => x.pos).sort((a, b) => a - b);
      expect(ps).toEqual(ps.map((_, i) => i));
    }
  });

  it("explains each state in words", () => {
    expect(whyText(m, at(30))).toBe("Waiting on T-31; opens by itself once they all merge.");
    expect(whyText(m, at(26))).toContain("T-23, T-58");
    expect(whyText(m, at(21))).toContain("T-18");
    expect(whyText(m, at(23))).toContain("cycle (T-23, T-58)");
    expect(whyText(m, at(99))).toContain("agent-blocked");
    expect(whyText(m, at(18))).toBe("Failed in the pipeline (label agent-failed). Requeue it from Issue actions once the cause is fixed. Holds back 1 issue above it.");
  });

  it("an empty board is an empty map", () => {
    const e = buildDepMap([]);
    expect([e.nodes.length, e.free.length, e.layers, e.cycles.length]).toEqual([0, 0, 0, 0]);
  });
});

describe("dependency map with closed issues", () => {
  const done: GhDone[] = [
    { n: 3, title: "[T-3] three", tag: "T-3", milestone: "M1 Engine", closed_at: 1_791_600_000, reason: "completed", deps: [] },
    { n: 9, title: "[T-9] nine", tag: "T-9", milestone: "M1 Engine", closed_at: 1_791_700_000, reason: "completed", deps: [3] },
    { n: 50, title: "[T-50] closed", tag: "T-50", milestone: null, closed_at: 1_791_000_000, reason: "not_planned", deps: [] },
  ];
  const issues: GhIssue[] = [
    { ...iss(23, "blocked", [58]), deps_all: [9, 58] }, // waited for #9 (now closed), still waits for #58
    iss(58, "eligible"),
    { ...iss(31, "eligible"), deps_all: [3] },
  ];
  const m = buildDepMap(issues, done);
  const at = (n: number) => [...m.nodes, ...m.free].find((x) => x.n === n)!;

  it("closed issues are done nodes; history edges are not live", () => {
    expect([at(3).state, at(9).state]).toEqual(["done", "done"]);
    expect(m.edges.find((e) => e.from === 9 && e.to === 23)).toEqual({ from: 9, to: 23, live: false, cycle: false });
    expect(m.edges.find((e) => e.from === 58 && e.to === 23)!.live).toBe(true);
    expect(m.edges.find((e) => e.from === 3 && e.to === 9)!.live).toBe(false);
  });

  it("states still come from open dependencies only", () => {
    expect(at(23).state).toBe("waiting");
    expect([at(23).deps, at(23).past]).toEqual([[58], [9]]);
    expect(at(31).state).toBe("ready");
  });

  it("layers run from the oldest closed work to what still waits", () => {
    expect([at(3).rank, at(9).rank, at(58).rank, at(31).rank, at(23).rank]).toEqual([0, 1, 0, 1, 2]);
  });

  it("unblocks counts closed and open issues above", () => {
    expect(at(3).unblocks).toBe(3); // 9, 31 and, through 9, 23
  });

  it("a closed issue with no edge is free; the summary counts done", () => {
    expect(m.free.map((x) => x.n)).toEqual([50]);
    expect(m.summary.done).toBe(3);
  });

  it("a done issue says when, and what it opened the way for", () => {
    // the date is in the viewer's locale and zone, so only its year is pinned here
    expect(whyText(m, at(9))).toMatch(/^Done .*2026\. Unblocked T-23\.$/);
    expect(whyText(m, at(50))).toMatch(/^Closed as not planned .*2026\.$/);
    const many = buildDepMap([4, 5, 6, 7].map((n) => ({ ...iss(n, "eligible"), deps_all: [3] })), done);
    expect(whyText(many, [...many.nodes, ...many.free].find((x) => x.n === 3)!)).toMatch(/Unblocked 5 issues\.$/); // 4, 5, 6, 7 and the closed #9
  });

  it("an issue that is both open and in done counts as open", () => {
    const m2 = buildDepMap([iss(9, "eligible")], done);
    expect([...m2.nodes, ...m2.free].find((x) => x.n === 9)!.state).toBe("ready");
  });
});
