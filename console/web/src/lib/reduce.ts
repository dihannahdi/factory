// The one reducer. SSE events and the polling fallback both go through apply(), so the two
// transports can never disagree. Pure: returns a new snapshot, never mutates its input.
import type { Item, Slot, Snapshot, StreamKey } from "./types";

export const ACTIVITY_KEEP = 50;

export function emptySlot(k: number): Slot {
  return {
    slot: k, run_id: null, state: "parked", stage: null, sub: "", issue: null, pr: null, model: null, session: null,
    turn: null, stage_started: null, issue_started: null, tokens: null, requirements: null, ci: null,
    steer: null, interrupt: null, note: "", effective_agents: 0, log_dir: null, updated: 0,
  };
}

export function emptySnapshot(): Snapshot {
  return {
    now: Math.floor(Date.now() / 1000), readonly: false,
    control: { agents: 1, models: [], model_mode: "ordered", paused: false, queue: [], skip: [], resume_ack: null },
    slots: [emptySlot(1), emptySlot(2), emptySlot(3)],
    activity: { "1": [], "2": [], "3": [] },
    github: null, models: null, halt: null, consumed: {}, metrics: null, recent: [],
  };
}

export function mergeActivity(prev: Item[] | undefined, items: Item[], reset: boolean | undefined): Item[] {
  const base = reset ? [] : (prev ?? []);
  return [...base, ...items].slice(-ACTIVITY_KEEP);
}

export function apply(snap: Snapshot, key: StreamKey | string, data: unknown): Snapshot {
  switch (key) {
    case "snapshot": {
      const s = data as Snapshot;
      return { ...s, activity: { "1": [], "2": [], "3": [], ...s.activity } };
    }
    case "slot": {
      const s = data as Slot;
      if (!(s.slot >= 1 && s.slot <= 3)) return snap;
      const slots = snap.slots.slice();
      slots[s.slot - 1] = s;
      return { ...snap, slots };
    }
    case "activity": {
      const a = data as { slot: number; items: Item[]; reset?: boolean };
      const k = String(a.slot);
      return { ...snap, activity: { ...snap.activity, [k]: mergeActivity(snap.activity[k], a.items, a.reset) } };
    }
    case "control": return { ...snap, control: data as Snapshot["control"] };
    case "github": return { ...snap, github: data as Snapshot["github"] };
    case "models": return { ...snap, models: data as Snapshot["models"] };
    case "metrics": return { ...snap, metrics: data as Snapshot["metrics"] };
    case "halt": return { ...snap, halt: data as Snapshot["halt"] };
    case "recent": return { ...snap, recent: data as Snapshot["recent"] };
    case "consumed": return { ...snap, consumed: data as Snapshot["consumed"] };
    default: return snap;
  }
}

/** Number of `tool` items an activity event adds: each one is one press stroke. */
export function strokesIn(items: Item[]): number {
  return items.reduce((n, i) => n + (i.kind === "tool" ? 1 : 0), 0);
}
