import { describe, expect, it } from "vitest";
import { PLATE_COLS, baseName, clip, fitCols, flapFrame, fmtThink, fmtWait, itemText, latestText, plateLabel } from "../src/lib/plate";
import type { Item } from "../src/lib/types";

const tool = (tool: string, target: string | null): Item => ({ t: 1, kind: "tool", tool, target });
const text = (t: string): Item => ({ t: 2, kind: "text", text: t });

describe("plate item text", () => {
  it("formats the common tools", () => {
    expect(itemText(tool("bash", "cargo build --workspace"))).toBe("$ cargo build --workspace");
    expect(itemText(tool("edit", "crates/shop-api/src/db.rs"))).toBe("edit db.rs");
    expect(itemText(tool("read", "docs/grid_power.md"))).toBe("read grid_power.md");
    expect(itemText(tool("write", "C:\\work\\x\\main.rs"))).toBe("write main.rs");
    expect(itemText(tool("grep", "latitude|longitude"))).toBe("grep latitude|longitude");
    expect(itemText(tool("task", "explore …"))).toBe("task explore …");
    expect(itemText(tool("webfetch", "https://www.example.com/a/b?q=1"))).toBe("fetch example.com");
  });
  it("never exceeds the column budget", () => {
    const long = "x".repeat(200);
    const err: Item = { t: 1, kind: "error", text: long };
    for (const it of [tool("bash", long), tool("grep", long), tool("read", long), tool("task", long), text(long), err])
      expect(itemText(it)!.length).toBeLessThanOrEqual(PLATE_COLS);
    expect(itemText(tool("bash", long))!.endsWith("…")).toBe(true);
  });
  it("keeps the basename of a long path, drops the directories", () => {
    expect(itemText(tool("edit", "a/very/long/directory/chain/that/goes/on/and/on/solar_geometry_tests.rs"))).toBe("edit solar_geometry_tests.rs");
  });
  it("quotes prose and closes the quote inside the budget", () => {
    expect(itemText(text("Let me check the"))).toBe("“Let me check the”");
    const s = itemText(text("Let me check the grid power module and then wire the zones together"))!;
    expect(s.startsWith("“Let me check")).toBe(true);
    expect(s.endsWith("…”")).toBe(true);
    expect(s.length).toBe(PLATE_COLS);
  });
  it("handles missing fields and control characters", () => {
    expect(itemText(tool("bash", null))).toBe("$ …");
    expect(itemText(tool("bash", "echo a\nb\tc"))).toBe("$ echo a b c");
    expect(itemText(text("   "))).toBeNull();
    expect(itemText({ t: 1, kind: "step", tokens: { in: 1, out: 1 } })).toBeNull();
    expect(itemText({ t: 1, kind: "error", text: "boom" })).toBe("! boom");
  });
  it("latestText skips steps", () => {
    expect(latestText([tool("bash", "ls"), { t: 3, kind: "step", tokens: { in: 1, out: 1 } }])).toBe("$ ls");
    expect(latestText([])).toBeNull();
  });
  it("baseName and clip", () => {
    expect(baseName("/home/factory/s1/work/src/lib.rs")).toBe("lib.rs");
    expect(baseName("src\\lib.rs")).toBe("lib.rs");
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
  });
});

describe("plate label", () => {
  const base = { stage: "build", sub: "", turn: true, items: [tool("bash", "ls")], silence: 1, checks: null, elapsed: 30 };
  it("shows the newest item while events keep coming", () => {
    expect(plateLabel(base)).toEqual({ text: "$ ls", key: "$ ls" });
  });
  it("says thinking after 5 s of silence, with a ticking counter under one key", () => {
    const a = plateLabel({ ...base, silence: 6.4 });
    const b = plateLabel({ ...base, silence: 12.9 });
    expect(a.text).toBe("thinking · 6s");
    expect(b.text).toBe("thinking · 12s");
    expect(a.key).toBe(b.key); // a ticking counter must not re-flip the plate
    expect(plateLabel({ ...base, silence: 5 }).text).toBe("$ ls");
    expect(plateLabel({ ...base, silence: 75 }).text).toBe("thinking · 1m15s");
  });
  it("waiting lanes read from the slot", () => {
    expect(plateLabel({ ...base, stage: "ci", turn: false, checks: 3 }).text).toBe("ci · 3 checks");
    expect(plateLabel({ ...base, stage: "ci", turn: false, checks: 1 }).text).toBe("ci · 1 check");
    expect(plateLabel({ ...base, stage: "ci", turn: false, checks: null }).text).toBe("ci · queued");
    expect(plateLabel({ ...base, stage: "deploy", turn: false, elapsed: 250 }).text).toBe("deploy · 4m");
    expect(plateLabel({ ...base, stage: "verify", turn: false, elapsed: 42 }).text).toBe("verify · 42s");
    expect(plateLabel({ ...base, stage: "verify", turn: false, sub: "fix 1/3" }).text).toBe("verify · fix 1/3");
  });
  it("a fresh turn with no items yet still says something", () => {
    expect(plateLabel({ ...base, items: [], silence: 0 }).text).toBe("build …");
  });
  it("wait formats", () => {
    expect(fmtWait(45)).toBe("45s");
    expect(fmtWait(250)).toBe("4m");
    expect(fmtWait(3720)).toBe("1h02m");
    expect(fmtThink(-3)).toBe("0s");
  });
});

describe("split-flap", () => {
  it("starts blank, ends on the text, and keeps the length", () => {
    expect(flapFrame("edit db.rs", 0, 0).trim()).toBe("");
    expect(flapFrame("edit db.rs", 1, 0)).toBe("edit db.rs");
    for (const p of [0.1, 0.4, 0.7, 0.95]) expect(flapFrame("edit db.rs", p, 3).length).toBe(10);
  });
  it("resolves left to right", () => {
    const f = flapFrame("abcdefghij", 0.6, 1);
    const resolved = [...f].filter((c, i) => c === "abcdefghij"[i]).length;
    expect(resolved).toBeGreaterThan(2);
    expect(f.endsWith(" ")).toBe(true);
  });
});

describe("plate fitCols", () => {
  it("leaves a line that fits alone", () => {
    expect(fitCols("$ cargo test", 22)).toBe("$ cargo test");
  });
  it("cuts with an ellipsis to exactly n columns", () => {
    const r = fitCols("$ cargo test --workspace --locked", 22);
    expect(r).toBe("$ cargo test --worksp…");
    expect(r.length).toBe(22);
  });
  it("keeps the closing quote of a model sentence", () => {
    expect(fitCols("“hello world”", 8)).toBe("“hello…”");
    expect(fitCols("“already clipped…”", 10)).toBe("“already…”");
  });
});
