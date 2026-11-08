// Hand-written from contracts/SCHEMA.md. Runtime guards for every shape live in guards.ts and
// are exercised against contracts/fixtures/ui/ by test/fixtures.test.ts.

export const STAGES = ["pick", "plan", "build", "verify", "review", "pr", "ci", "merge", "deploy", "live"] as const;
export type Stage = (typeof STAGES)[number];

export type SlotState = "parked" | "idle" | "running" | "draining" | "stopping" | "stopped" | "halted" | "backoff";
export type IssueClass = "running" | "queued" | "eligible" | "taken" | "blocked" | "failed" | "skipped" | "ineligible";

export interface Tokens {
  input: number;
  output: number;
  reasoning?: number;
  cache_read: number;
}
export interface IssueRef {
  n: number;
  title: string;
  tag: string | null;
  family: string | null;
  url: string;
}
export interface CiCheck {
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | skipped | ...
}
export interface SteerRecord {
  id: string;
  message: string;
  at?: string;
  applied_at?: number;
  outcome?: string; // applied | dropped | ...
}
export interface Slot {
  v?: number;
  slot: number;
  run_id: string | null;
  state: SlotState;
  stage: Stage | null;
  sub: string;
  issue: IssueRef | null;
  pr: { n: number; url: string; head: string } | null;
  model: string | null;
  session: string | null;
  turn: { phase: string; started: number; events: string } | null;
  stage_started: number | null;
  issue_started: number | null;
  tokens: Tokens | null;
  requirements: { total: number; done: number } | null;
  ci: { checks: CiCheck[]; head: string } | null;
  steer: { pending: SteerRecord | null; last: SteerRecord | null } | null;
  interrupt: { last_id: string; action: string; handled_at: number } | null;
  note: string;
  effective_agents: number;
  log_dir: string | null;
  updated: number;
  stale?: boolean; // set by the console when run_id != null and updated is older than 120 s
}

export interface GhIssue {
  n: number;
  /** Body size numbers from sync (SCHEMA 3.2); absent on older github.json. */
  size?: { chars: number; bullets: number; checkboxes: number };
  title: string;
  tag: string | null;
  family: string | null;
  milestone: string | null;
  priority: string | null;
  labels: string[];
  class: IssueClass;
  reason: string;
  deps: number[];
  taken_by: number[];
  claimed_by: number | null;
  order: number | null;
  url: string;
  /** Set only when a human PR labelled agent-adopt closes this issue (SCHEMA 3.2). */
  adopt_pr?: number;
  /** every dependency the issue ever declared, whatever its state, plus deps (SCHEMA 3.2); optional */
  deps_all?: number[];
}
/** A closed issue (SCHEMA 3.2 `done`), for the dependency map. */
export interface GhDone {
  n: number;
  title: string;
  tag: string | null;
  milestone: string | null;
  closed_at: number | null;
  reason: string;
  deps: number[];
}
export interface GhPr {
  n: number;
  issue: number | null;
  title: string;
  head: string;
  agent: boolean;
  ci: string;
  mergeable: string;
  created: number;
  url: string;
}
export interface Github {
  v?: number;
  updated: number;
  ok: boolean;
  error: string | null;
  issues: GhIssue[];
  prs: GhPr[];
  /** agent-adopt labels that were ignored, with the reason (SCHEMA 3.2). */
  adopt_ignored?: { pr: number; reason: string }[];
  /** closed issues (SCHEMA 3.2); absent on an older sync */
  done?: GhDone[];
  runner: { queued: number; in_progress: number };
  main: { sha: string; deploy: { sha: string; status: string; conclusion: string | null; url: string } | null };
  health: { ok: boolean; checked: number };
}

export interface FreeModel {
  id: string;
  name: string;
  context: number;
  output: number;
  trains_on_data: boolean | null;
  /** true = documented zero retention; false = kept and/or used by the provider; null = unknown. Absent on old files. */
  zero_retention?: boolean | null;
}
/** Go spend in USD against the flat plan's windows; published by sync from the spend ledger. */
export interface Spend {
  h5: number;
  week: number;
  month: number;
  budget: { h5: number; week: number; month: number };
}
export interface Models {
  v?: number;
  updated: number;
  free: FreeModel[];
  /** OpenCode Go models; present only while the Go key is installed. */
  paid?: FreeModel[];
  spend?: Spend;
  cooldown: Record<string, { until: number; reason: string }>;
  source_ok: { zen: boolean; modelsdev: boolean };
}

export interface Halt {
  id: string;
  reason: string;
  at: number;
  issue_url: string | null;
}
export type Consumed = Record<string, string>;

export interface Control {
  v?: number;
  agents: number;
  models: string[];
  model_mode: "ordered" | "auto";
  paused: boolean;
  queue: { n: number; at: string }[];
  skip: number[];
  resume_ack: string | null;
  updated_at?: string;
}

export interface Item {
  t: number;
  kind: "tool" | "text" | "step" | "error";
  tool?: string | null;
  target?: string | null;
  text?: string | null;
  status?: string | null;
  tokens?: { in: number; out: number } | null;
}
export interface SizeModel {
  active: boolean;
  feature: string | null;
  n: number;
  flat_mae: number | null;
  mae: number | null;
}
export interface EtaInfo {
  p50_h: number;
  p80_h: number | null;
  lanes: number;
  rate_per_lane_h: number;
  merges_per_issue: number;
  doable: number;
  waiting_human: { n: number; tag: string | null }[];
  size_model: SizeModel;
  /** P80 = P50 x max(q_effort, q_rate); null from a console older than these fields */
  q_effort: number | null;
  q_rate: number | null;
  dispersion: number | null;
}
export interface TokensTotal {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  since: number | null;
}
export interface Metrics {
  merged_total: number;
  merged_24h: number;
  merged_7d: number;
  remaining: number;
  throughput_per_h: number;
  eta_h: number | null;
  eta: EtaInfo | null;
  waste_per_productive_h_7d: number | null;
  success: Record<string, { attempts: number; merged: number; rate: number }>;
  stage_median_min: Partial<Record<Stage, number>>;
  bottleneck: string | null;
  tokens_today: { input: number; output: number; cache_read: number };
  /** every call record ever read; null from a console older than this field */
  tokens_total: TokensTotal | null;
  rate_limited_1h: number;
}
export interface Outcome {
  ts: number;
  issue: number;
  slot: number;
  outcome: string;
  model?: string | null;
  url?: string | null;
}
export interface StatLine {
  ts: number;
  issue: number;
  slot?: number;
  kind: "call" | "stage" | "steer" | "outcome";
  [k: string]: unknown;
}

export interface Snapshot {
  v?: number;
  now: number;
  readonly: boolean;
  control: Control;
  slots: Slot[];
  activity: Record<string, Item[]>;
  github: Github | null;
  models: Models | null;
  halt: Halt | null;
  consumed: Consumed;
  metrics: Metrics | null;
  recent: Outcome[];
}

export type StreamEvent =
  | { key: "snapshot"; data: Snapshot }
  | { key: "slot"; data: Slot }
  | { key: "activity"; data: { slot: number; items: Item[]; reset?: boolean } }
  | { key: "control"; data: Control }
  | { key: "github"; data: Github | null }
  | { key: "models"; data: Models | null }
  | { key: "metrics"; data: Metrics | null }
  | { key: "halt"; data: Halt | null }
  | { key: "recent"; data: Outcome[] }
  | { key: "consumed"; data: Consumed };

export type StreamKey = StreamEvent["key"];
export const STREAM_KEYS: StreamKey[] = ["snapshot", "slot", "activity", "control", "github", "models", "metrics", "halt", "recent", "consumed"];
