import { describe, expect, it } from "vitest";
import { evidenceFiles, headline } from "../src/lib/checklist";

describe("checklist headline", () => {
  it("cuts at the first clause break that leaves a real phrase", () => {
    expect(headline("Hourly usage profile: convert monthly->hourly while keeping the total")).toBe("Hourly usage profile");
    expect(headline("Engine picks the tariff per class + billing month; unknown classes rejected")).toBe("Engine picks the tariff per class + billing month");
    expect(headline("Frontend studio: tariff dropdown — no math in TS")).toBe("Frontend studio");
    expect(headline("All tests green; TS bindings regenerated")).toBe("All tests green");
  });
  it("keeps the whole line when the break comes too early or not at all", () => {
    expect(headline("API: GET /api/v1/tariffs, CRUD profiles")).toBe("API: GET /api/v1/tariffs, CRUD profiles");
    expect(headline("Versioned tariff table with customer classes")).toBe("Versioned tariff table with customer classes");
  });
  it("flattens control characters and runs of space", () => {
    expect(headline("  a\nb\t\tc  ")).toBe("a b c");
    expect(headline("")).toBe("");
  });
});

describe("checklist evidence files", () => {
  it("names each file once, by base name, in order of first mention", () => {
    const ev = "crates/shop-core/src/tariff.rs: TariffSchedule; migration crates/shop-api/migrations/0015_tariff_schedules.sql; test out02_tariff.rs::unknown_tariff_code_is_422; tariff.rs again";
    expect(evidenceFiles(ev)).toEqual(["tariff.rs", "0015_tariff_schedules.sql", "out02_tariff.rs"]);
  });
  it("handles windows paths, front-end files and docs", () => {
    expect(evidenceFiles("C:\\work\\frontend\\src\\pages\\studio.astro and docs/validation/0.5.0/report.md")).toEqual(["studio.astro", "report.md"]);
  });
  it("ignores versions, crate names and words with dots", () => {
    expect(evidenceFiles("ENGINE_VERSION 0.4.0 -> 0.5.0; shop-core; e.g. passes; cargo test --workspace")).toEqual([]);
    expect(evidenceFiles(null)).toEqual([]);
  });
  it("does not take a longer extension's prefix", () => {
    expect(evidenceFiles("see notes.mdx and data.jsonl")).toEqual([]);
  });
});
