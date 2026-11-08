// Runtime guards: cheap structural checks on the fields the UI actually reads.
// Used for every incoming API payload (a malformed event is dropped, never half-applied)
// and by test/fixtures.test.ts against contracts/fixtures/ui/.
import { STAGES } from "./types";
import type { Control, Consumed, Github, GhIssue, Halt, Item, Metrics, Models, Outcome, Slot, Snapshot, StatLine } from "./types";

export type R = Record<string, unknown>;
export type Check = (v: unknown) => boolean;
export const obj = (v: unknown): v is R => typeof v === "object" && v !== null && !Array.isArray(v);
export const str: Check = (v) => typeof v === "string";
export const num: Check = (v) => typeof v === "number" && Number.isFinite(v);
export const bool: Check = (v) => typeof v === "boolean";
export const nul = (f: Check): Check => (v) => v === null || f(v);
export const arr = (f: Check): Check => (v) => Array.isArray(v) && v.every(f);
export const opt = (f: Check): Check => (v) => v === undefined || f(v);
export const shape = (s: Record<string, Check>): Check => (v) => obj(v) && Object.entries(s).every(([k, f]) => f(v[k]));

const SLOT_STATES = ["parked", "idle", "running", "draining", "stopping", "stopped", "halted", "backoff"];
const CLASSES = ["running", "queued", "eligible", "taken", "blocked", "failed", "skipped", "ineligible"];

const issueRef = shape({ n: num, title: str, url: str, tag: nul(str), family: nul(str) });
const tokens = shape({ input: num, output: num, cache_read: num });
export const slotShape = shape({
  slot: (v) => v === 1 || v === 2 || v === 3,
  run_id: nul(str),
  state: (v) => typeof v === "string" && SLOT_STATES.includes(v),
  stage: nul((v) => typeof v === "string" && (STAGES as readonly string[]).includes(v)),
  sub: str,
  issue: nul(issueRef),
  pr: nul(shape({ n: num, url: str, head: str })),
  model: nul(str),
  turn: nul(shape({ phase: str, started: num, events: str })),
  stage_started: nul(num),
  issue_started: nul(num),
  tokens: nul(tokens),
  requirements: nul(shape({ total: num, done: num })),
  ci: nul(shape({ head: str, checks: arr(shape({ name: str, status: str, conclusion: nul(str) })) })),
  steer: nul(shape({ pending: nul(shape({ id: str, message: str })), last: nul(shape({ id: str, message: str })) })),
  note: str,
  effective_agents: num,
  updated: nul(num),
});
export const isSlot = (v: unknown): v is Slot => slotShape(v);

export const ghIssue = shape({
  n: num, title: str, tag: nul(str), milestone: nul(str), priority: nul(str),
  class: (v) => typeof v === "string" && CLASSES.includes(v), reason: str, deps: arr(num), taken_by: arr(num),
  claimed_by: nul(num), order: nul(num), url: str,
});
export const isGhIssue = (v: unknown): v is GhIssue => ghIssue(v);
export const ghDone = shape({ n: num, title: str, tag: nul(str), milestone: nul(str), closed_at: nul(num), reason: str, deps: arr(num) });
const github = shape({
  updated: num, ok: bool, issues: arr(ghIssue),
  prs: arr(shape({ n: num, title: str, url: str })),
  runner: shape({ queued: num, in_progress: num }),
  main: shape({ sha: str }),
  health: shape({ ok: bool, checked: num }),
});
export const isGithub = (v: unknown): v is Github => github(v);

export const modelShape = shape({ id: str, name: str, trains_on_data: nul(bool), zero_retention: (v) => v === undefined || v === null || typeof v === "boolean" });
export const spendShape = shape({
  h5: num, week: num, month: num,
  budget: shape({ h5: num, week: num, month: num }),
});
const models = shape({
  updated: nul(num),
  free: arr(modelShape),
  paid: opt(arr(modelShape)),
  spend: opt(spendShape),
  cooldown: (v) => obj(v) && Object.values(v).every(shape({ until: num, reason: str })),
});
export const isModels = (v: unknown): v is Models => models(v);

const halt = shape({ id: str, reason: str, at: num, issue_url: nul(str) });
export const isHalt = (v: unknown): v is Halt => halt(v);

export const isConsumed = (v: unknown): v is Consumed => obj(v) && Object.values(v).every((x) => typeof x === "string");

export const control = shape({
  agents: (v) => num(v) && (v as number) >= 0 && (v as number) <= 3,
  models: arr(str),
  model_mode: (v) => v === "ordered" || v === "auto",
  paused: bool,
  queue: arr(shape({ n: num, at: str })),
  skip: arr(num),
  resume_ack: nul(str),
});
export const isControl = (v: unknown): v is Control => control(v);

export const item = shape({
  t: num,
  kind: (v) => v === "tool" || v === "text" || v === "step" || v === "error",
  tool: opt(nul(str)), target: opt(nul(str)), text: opt(nul(str)), status: opt(nul(str)),
});
export const isItem = (v: unknown): v is Item => item(v);

export const sizeModel = shape({ active: bool, feature: nul(str), n: num, flat_mae: nul(num), mae: nul(num) });
export const etaInfo = shape({
  p50_h: num, p80_h: nul(num), lanes: num, rate_per_lane_h: num, merges_per_issue: num, doable: num,
  waiting_human: arr(shape({ n: num, tag: nul(str) })), size_model: sizeModel,
  q_effort: nul(num), q_rate: nul(num), dispersion: nul(num),
});

const metrics = shape({
  merged_total: num, merged_24h: num, merged_7d: num, remaining: num, throughput_per_h: num, eta_h: nul(num),
  bottleneck: nul(str), rate_limited_1h: num,
  eta: opt(nul(etaInfo)), waste_per_productive_h_7d: opt(nul(num)),
  tokens_today: shape({ input: num, output: num, cache_read: num }),
  tokens_total: opt(nul(shape({ input: num, output: num, reasoning: num, cache_read: num, since: nul(num) }))),
});
export const isMetrics = (v: unknown): v is Metrics => metrics(v);

export const outcome = shape({ ts: num, issue: num, slot: num, outcome: str });
export const isOutcome = (v: unknown): v is Outcome => outcome(v);

export const isStatLine = (v: unknown): v is StatLine =>
  shape({ ts: num, issue: num, kind: (k) => k === "call" || k === "stage" || k === "steer" || k === "outcome" })(v);

const snapshot = shape({
  now: num, readonly: bool, control, slots: (v) => Array.isArray(v) && v.length === 3 && v.every(slotShape),
  activity: (v) => obj(v) && Object.values(v).every(arr(item)),
  github: nul(github), models: nul(models), halt: nul(halt), consumed: (v) => isConsumed(v),
  metrics: nul(metrics), recent: arr(outcome),
});
export const isSnapshot = (v: unknown): v is Snapshot => snapshot(v);

/** Validate one SSE event; unknown keys and malformed payloads return false. */
export function isEventPayload(key: string, data: unknown): boolean {
  switch (key) {
    case "snapshot": return isSnapshot(data);
    case "slot": return isSlot(data);
    case "activity": return obj(data) && num(data.slot) && Array.isArray(data.items) && data.items.every(isItem);
    case "control": return isControl(data);
    case "github": return data === null || isGithub(data);
    case "models": return data === null || isModels(data);
    case "metrics": return data === null || isMetrics(data);
    case "halt": return data === null || isHalt(data);
    case "recent": return arr(outcome)(data);
    case "consumed": return isConsumed(data);
    default: return false;
  }
}
