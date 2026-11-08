// Tolerant intake. A part that is off is repaired or replaced; it never costs the rest of the payload.
// (Found the hard way: one slot with `updated: null` used to make an all-or-nothing guard drop a whole
// production snapshot, and the dashboard showed every lane parked.)
import { bool, control, etaInfo, ghDone, ghIssue, isConsumed, isHalt, item, modelShape, num, obj, outcome, shape, slotShape, spendShape, str } from "./guards";
import { emptySlot, emptySnapshot } from "./reduce";
import type { Control, GhDone, GhIssue, Github, Item, Metrics, Models, Outcome, Slot, Snapshot } from "./types";

const nowS = (): number => Math.floor(Date.now() / 1000);
const keep = <T>(v: unknown, f: (x: unknown) => boolean): T[] => (Array.isArray(v) ? (v.filter(f) as T[]) : []);

/** One slot: missing fields default, `updated: null` becomes 0, anything still invalid becomes a blank parked slot. */
export function sanitizeSlot(v: unknown, k: number): Slot {
  if (!obj(v)) return emptySlot(k);
  const c = { ...emptySlot(k), ...v, slot: k, updated: num(v.updated) ? v.updated : 0 } as Record<string, unknown>;
  return slotShape(c) ? (c as unknown as Slot) : emptySlot(k);
}

function cleanControl(v: unknown): Control | undefined {
  if (!obj(v)) return undefined;
  const c = { ...emptySnapshot().control, ...v };
  return control(c) ? (c as unknown as Control) : undefined;
}

function cleanGithub(v: unknown): Github | undefined {
  if (!obj(v)) return undefined;
  const main = obj(v.main) && str(v.main.sha) ? v.main : { sha: "", deploy: null };
  return {
    ...v,
    updated: num(v.updated) ? v.updated : 0,
    ok: v.ok !== false,
    error: str(v.error) ? v.error : null,
    issues: keep<GhIssue>(v.issues, ghIssue),
    done: keep<GhDone>(v.done, ghDone),
    prs: keep(v.prs, shape({ n: num, title: str, url: str })),
    runner: shape({ queued: num, in_progress: num })(v.runner) ? v.runner : { queued: 0, in_progress: 0 },
    main,
    health: shape({ ok: bool, checked: num })(v.health) ? v.health : { ok: true, checked: 0 },
  } as unknown as Github;
}

function cleanModels(v: unknown): Models | undefined {
  if (!obj(v)) return undefined;
  const cd: Record<string, unknown> = {};
  if (obj(v.cooldown)) for (const [id, e] of Object.entries(v.cooldown)) if (shape({ until: num, reason: str })(e)) cd[id] = e;
  return {
    ...v,
    updated: num(v.updated) ? v.updated : 0,
    free: keep(v.free, modelShape),
    paid: keep(v.paid, modelShape),
    spend: spendShape(v.spend) ? v.spend : undefined,
    cooldown: cd,
    source_ok: obj(v.source_ok) ? v.source_ok : { zen: true, modelsdev: true },
  } as unknown as Models;
}

/** eta must be whole or absent; a half-shaped one (older console, odd payload) would only mislead. */
function cleanEta(v: unknown): Metrics["eta"] {
  if (!obj(v)) return null;
  const sm = obj(v.size_model) ? v.size_model : {};
  const c = {
    q_effort: null, q_rate: null, dispersion: null,
    ...v,
    waiting_human: keep(v.waiting_human, shape({ n: num, tag: (t) => t === null || str(t) })),
    size_model: { active: false, feature: null, n: 0, flat_mae: null, mae: null, ...sm },
  };
  return etaInfo(c) ? (c as unknown as Metrics["eta"]) : null;
}

function cleanMetrics(v: unknown): Metrics | undefined {
  if (!obj(v)) return undefined;
  const n = (x: unknown) => (num(x) ? (x as number) : 0);
  const t = obj(v.tokens_today) ? v.tokens_today : {};
  return {
    ...v,
    merged_total: n(v.merged_total), merged_24h: n(v.merged_24h), merged_7d: n(v.merged_7d), remaining: n(v.remaining), throughput_per_h: n(v.throughput_per_h),
    eta_h: num(v.eta_h) ? v.eta_h : null, eta: cleanEta(v.eta), waste_per_productive_h_7d: num(v.waste_per_productive_h_7d) ? v.waste_per_productive_h_7d : null, bottleneck: str(v.bottleneck) ? v.bottleneck : null, rate_limited_1h: n(v.rate_limited_1h),
    success: obj(v.success) ? v.success : {}, stage_median_min: obj(v.stage_median_min) ? v.stage_median_min : {},
    tokens_today: { input: n(t.input), output: n(t.output), cache_read: n(t.cache_read) },
    tokens_total: obj(v.tokens_total)
      ? { input: n(v.tokens_total.input), output: n(v.tokens_total.output), reasoning: n(v.tokens_total.reasoning),
          cache_read: n(v.tokens_total.cache_read), since: num(v.tokens_total.since) ? v.tokens_total.since : null }
      : null,
  } as unknown as Metrics;
}

function cleanActivity(v: unknown): Record<string, Item[]> {
  const out: Record<string, Item[]> = { "1": [], "2": [], "3": [] };
  if (obj(v)) for (const [k, items] of Object.entries(v)) out[k] = keep<Item>(items, item);
  return out;
}

export type Clean = { ok: true; value: unknown } | { ok: false };
const yes = (value: unknown): Clean => ({ ok: true, value });
const no: Clean = { ok: false };

/** Repairs a whole snapshot key by key. Only a non-object payload is rejected; invalid keys fall back to `prev`. */
export function sanitizeSnapshot(v: unknown, prev: Snapshot): Snapshot | null {
  if (!obj(v)) return null;
  const slotsIn = Array.isArray(v.slots) ? v.slots : [];
  const slots = [1, 2, 3].map((k) => sanitizeSlot(slotsIn.find((s) => obj(s) && s.slot === k) ?? slotsIn[k - 1], k));
  const g = v.github === null ? null : cleanGithub(v.github);
  const m = v.models === null ? null : cleanModels(v.models);
  const me = v.metrics === null ? null : cleanMetrics(v.metrics);
  return {
    v: num(v.v) ? (v.v as number) : 1,
    now: num(v.now) ? (v.now as number) : nowS(),
    readonly: v.readonly === true,
    control: cleanControl(v.control) ?? prev.control,
    slots,
    activity: cleanActivity(v.activity),
    github: g === undefined ? prev.github : g,
    models: m === undefined ? prev.models : m,
    halt: isHalt(v.halt) ? v.halt : null,
    consumed: isConsumed(v.consumed) ? v.consumed : {},
    metrics: me === undefined ? prev.metrics : me,
    recent: keep<Outcome>(v.recent, outcome),
  };
}

/** One SSE event, repaired per key. An event that cannot be repaired is dropped on its own. */
export function sanitizeEvent(key: string, data: unknown, prev: Snapshot): Clean {
  switch (key) {
    case "snapshot": { const s = sanitizeSnapshot(data, prev); return s ? yes(s) : no; }
    case "slot": return obj(data) && (data.slot === 1 || data.slot === 2 || data.slot === 3) ? yes(sanitizeSlot(data, data.slot)) : no;
    case "activity": return obj(data) && num(data.slot) && Array.isArray(data.items) ? yes({ slot: data.slot, items: keep<Item>(data.items, item), reset: data.reset === true }) : no;
    case "control": { const c = cleanControl(data); return c ? yes(c) : no; }
    case "github": { if (data === null) return yes(null); const c = cleanGithub(data); return c ? yes(c) : no; }
    case "models": { if (data === null) return yes(null); const c = cleanModels(data); return c ? yes(c) : no; }
    case "metrics": { if (data === null) return yes(null); const c = cleanMetrics(data); return c ? yes(c) : no; }
    case "halt": return data === null ? yes(null) : isHalt(data) ? yes(data) : no;
    case "recent": return Array.isArray(data) ? yes(keep<Outcome>(data, outcome)) : no;
    case "consumed": return isConsumed(data) ? yes(data) : no;
    default: return no;
  }
}
