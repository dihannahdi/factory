// Derived, display-ready facts about one lane. Pure: (slot, now) in, plain object out.
import { STAGES } from "./types";
import type { CiCheck, Slot, Stage } from "./types";

export type LampState = "ok" | "run" | "wait" | "fail" | "off";

export interface LaneVM {
  k: number; // 0-based
  slot: Slot;
  dormant: boolean; // parked: above the agent count
  hasIssue: boolean;
  working: boolean; // an agent is somewhere in the pipeline right now
  stageIdx: number; // -1 when none
  stage: Stage | null;
  sub: string;
  tag: string;
  title: string;
  elapsed: number | null; // seconds in the current stage
  total: number | null; // seconds on this issue
  complete: { r: number; of: number } | null; // "complete 2/4"
  fix: { r: number; of: number } | null; // "fix 1/3"
  verifyFailing: boolean;
  deferred: boolean; // "stop deferred"
  canInterrupt: boolean;
  stale: boolean;
  lamps: LampState[];
  steer: { state: "pending" | "applied" | "dropped"; message: string } | null;
}

const WORKING = new Set(["running", "draining", "stopping"]);

export function stageIndex(stage: Stage | null | undefined): number {
  return stage ? STAGES.indexOf(stage) : -1;
}

export function lampOf(c: CiCheck): LampState {
  if (c.status === "completed") {
    if (c.conclusion === "success") return "ok";
    if (c.conclusion === "skipped" || c.conclusion === "neutral") return "off";
    return "fail";
  }
  if (c.status === "in_progress") return "run";
  return "wait";
}

export function parseRatio(sub: string, word: string): { r: number; of: number } | null {
  const m = new RegExp(`^${word} (\\d+)/(\\d+)`).exec(sub);
  return m ? { r: Number(m[1]), of: Number(m[2]) } : null;
}

export function laneVM(slot: Slot, now: number): LaneVM {
  const dormant = slot.state === "parked";
  const hasIssue = slot.issue != null && slot.run_id != null;
  const working = hasIssue && WORKING.has(slot.state);
  const stale = slot.run_id != null && now - slot.updated > 120;
  let steer: LaneVM["steer"] = null;
  const pend = slot.steer?.pending;
  const last = slot.steer?.last;
  if (pend) steer = { state: "pending", message: pend.message };
  else if (last && (last.applied_at == null || now - last.applied_at < 300)) {
    steer = { state: last.outcome === "applied" ? "applied" : "dropped", message: last.message };
  }
  const lamps: LampState[] = slot.ci ? slot.ci.checks.slice(0, 5).map(lampOf) : [];
  return {
    k: slot.slot - 1,
    slot,
    dormant,
    hasIssue,
    working,
    stageIdx: stageIndex(slot.stage),
    stage: slot.stage,
    sub: slot.sub,
    tag: slot.issue?.tag ?? (slot.issue ? `#${slot.issue.n}` : ""),
    title: slot.issue?.title ?? "",
    elapsed: slot.stage_started != null ? Math.max(0, now - slot.stage_started) : null,
    total: slot.issue_started != null ? Math.max(0, now - slot.issue_started) : null,
    complete: parseRatio(slot.sub, "complete"),
    fix: parseRatio(slot.sub, "fix"),
    verifyFailing: slot.stage === "verify" && /^fix /.test(slot.sub),
    deferred: slot.sub === "stop deferred",
    canInterrupt: slot.run_id != null && (slot.state === "running" || slot.state === "draining"),
    stale,
    lamps,
    steer,
  };
}

/** Where the work item stands along the lane for each stage (world x), and how high it rides. */
export const STAGE_X: Record<Stage, number> = {
  pick: 3, plan: 9, build: 15.5, verify: 22, review: 28.5, pr: 34.5, ci: 40.5, merge: 46.5, deploy: 50.5, live: 50.5,
};
