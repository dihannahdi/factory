import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isConsumed, isControl, isGithub, isHalt, isItem, isModels, isOutcome, isSlot, isSnapshot, isStatLine, isEventPayload } from "../src/lib/guards";

const FIX = path.resolve(__dirname, "../../../contracts/fixtures");
const json = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));

describe("contracts/fixtures/ui against the hand-written types (runtime guards)", () => {
  it("slots 1..3", () => {
    for (const k of [1, 2, 3]) expect(isSlot(json(`ui/slots/${k}.json`)), `slot ${k}`).toBe(true);
  });
  it("github.json", () => expect(isGithub(json("ui/github.json"))).toBe(true));
  it("models.json", () => expect(isModels(json("ui/models.json"))).toBe(true));
  it("halt.example.json", () => expect(isHalt(json("ui/halt.example.json"))).toBe(true));
  it("consumed.json", () => expect(isConsumed(json("ui/consumed.json"))).toBe(true));
  it("ctl/control.json", () => expect(isControl(json("ctl/control.json"))).toBe(true));
  it("every line of stats.jsonl", () => {
    const lines = fs.readFileSync(path.join(FIX, "ui/stats.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(isStatLine(JSON.parse(l)), l).toBe(true);
  });
  it("a snapshot assembled from the fixtures", () => {
    const snap = {
      v: 1, now: 1792130123, readonly: false, control: json("ctl/control.json"),
      slots: [1, 2, 3].map((k) => json(`ui/slots/${k}.json`)), activity: { "1": [], "2": [], "3": [] },
      github: json("ui/github.json"), models: json("ui/models.json"), halt: null, consumed: json("ui/consumed.json"),
      metrics: null, recent: [],
    };
    expect(isSnapshot(snap)).toBe(true);
    expect(isEventPayload("halt", json("ui/halt.example.json"))).toBe(true);
  });
  it("activity items per section 5.2", () => {
    expect(isItem({ t: 1792129929580, kind: "tool", tool: "bash", target: "cargo test", text: null, status: "completed", tokens: null })).toBe(true);
    expect(isItem({ kind: "tool" })).toBe(false);
  });
  it("rejects malformed payloads", () => {
    expect(isSlot({ ...json("ui/slots/1.json"), state: "weird" })).toBe(false);
    expect(isOutcome({ ts: "x" })).toBe(false);
    expect(isEventPayload("nope", {})).toBe(false);
  });
});
