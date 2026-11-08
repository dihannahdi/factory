// Control validation (SCHEMA section 2.1) shared by every API route that writes ctl/control.json,
// plus the store that serialises the writes.
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./files.mjs";

export const AGENTS_MAX = 3;
// opencode/<free model>, opencode-go/<paid Go model>, or opencode-go@N/<model> on Go account N (SCHEMA
// section 0, tested against contracts/fixtures/model-ids.json). Which of them are allowed is up to
// ui/models.json. Must accept every id lib.sh accepts: an id this rejects is dropped from control.json
// on the next console write, which is how account 2 silently left the lane list on 31 Oct 2026.
export const MODEL_RE = /^opencode(?:-go(?:@[0-9]+)?)?\/[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_QUEUE = 50;
export const MAX_SKIP = 200;
export const MAX_MODELS = 5;
export const MAX_MESSAGE = 2000;
const ACK_RE = /^[0-9A-Za-z._:-]{1,80}$/;

export const DEFAULT_CONTROL = Object.freeze({
  v: 1, agents: 1, models: ["opencode/deepseek-v4.1-flash-free"], model_mode: "ordered",
  paused: false, queue: [], skip: [], resume_ack: null, updated_at: null,
});

export const isoNow = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const posInt = (n) => Number.isInteger(n) && n > 0 && n < 1e9;

/** Lenient: turns whatever is on disk into a well-formed Control, field by field. */
export function normalizeControl(raw) {
  const d = DEFAULT_CONTROL;
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const okModel = (m) => typeof m === "string" && MODEL_RE.test(m);
  const models = Array.isArray(r.models) ? [...new Set(r.models.filter(okModel))].slice(0, MAX_MODELS) : [];
  // Never drop a model without a trace: the next write makes the drop permanent.
  const dropped = Array.isArray(r.models) ? r.models.filter((m) => !okModel(m)) : [];
  if (dropped.length) console.warn(`control: model ids rejected and dropped: ${JSON.stringify(dropped).slice(0, 300)}`);
  const seen = new Set();
  const queue = [];
  if (Array.isArray(r.queue)) {
    for (const q of r.queue) {
      if (q && posInt(q.n) && typeof q.at === "string" && q.at.length <= 40 && !seen.has(q.n)) {
        seen.add(q.n);
        queue.push({ n: q.n, at: q.at });
      }
    }
  }
  const skip = Array.isArray(r.skip) ? [...new Set(r.skip.filter(posInt))].slice(0, MAX_SKIP) : [];
  return {
    v: 1,
    agents: Number.isInteger(r.agents) && r.agents >= 0 && r.agents <= AGENTS_MAX ? r.agents : d.agents,
    models: models.length ? models : [...d.models],
    model_mode: r.model_mode === "auto" ? "auto" : "ordered",
    paused: r.paused === true,
    queue: queue.slice(0, MAX_QUEUE),
    skip,
    resume_ack: typeof r.resume_ack === "string" && ACK_RE.test(r.resume_ack) ? r.resume_ack : null,
    updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
  };
}

const PATCH_KEYS = new Set(["agents", "models", "model_mode", "paused", "resume_ack"]);

/**
 * Validates a partial control patch. ctx: {freeIds:Set|null, haltId:string|null}.
 * -> {ok:true, changes} | {ok:false, field}
 */
export function validatePatch(patch, ctx) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, field: "body" };
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: false, field: "body" };
  for (const k of keys) if (!PATCH_KEYS.has(k)) return { ok: false, field: k };
  const out = {};
  if ("agents" in patch) {
    const a = patch.agents;
    if (!Number.isInteger(a) || a < 0 || a > AGENTS_MAX) return { ok: false, field: "agents" };
    out.agents = a;
  }
  if ("models" in patch) {
    const m = patch.models;
    if (!Array.isArray(m) || m.length < 1 || m.length > MAX_MODELS) return { ok: false, field: "models" };
    if (new Set(m).size !== m.length) return { ok: false, field: "models" };
    // Least privilege: an id must be in ui/models.json free or paid (ctx.freeIds holds both), and with
    // no list on disk nothing passes.
    for (const id of m) {
      if (typeof id !== "string" || !MODEL_RE.test(id) || !ctx.freeIds || !ctx.freeIds.has(id)) return { ok: false, field: "models" };
    }
    out.models = [...m];
  }
  if ("model_mode" in patch) {
    if (patch.model_mode !== "ordered" && patch.model_mode !== "auto") return { ok: false, field: "model_mode" };
    out.model_mode = patch.model_mode;
  }
  if ("paused" in patch) {
    if (typeof patch.paused !== "boolean") return { ok: false, field: "paused" };
    out.paused = patch.paused;
  }
  if ("resume_ack" in patch) {
    const a = patch.resume_ack;
    // Only the halt that is actually showing can be acknowledged (or the ack cleared).
    if (a !== null && !(typeof a === "string" && ACK_RE.test(a) && ctx.haltId && a === ctx.haltId)) return { ok: false, field: "resume_ack" };
    out.resume_ack = a;
  }
  return { ok: true, changes: out };
}

/**
 * Applies an issue action to a control object (pure). ctx: {consumed:{n:isoString}|null}
 * -> {ok:true, control} | {ok:false, field}
 */
export function applyIssueAction(control, action, n, ctx = {}) {
  const c = { ...control, queue: [...control.queue], skip: [...control.skip] };
  switch (action) {
    case "queue": {
      c.queue = c.queue.filter((q) => q.n !== n);
      if (c.queue.length >= MAX_QUEUE) return { ok: false, field: "queue" };
      let at = isoNow();
      const used = ctx.consumed?.[String(n)];
      if (typeof used === "string" && used >= at) {
        const t = Date.parse(used);
        if (Number.isFinite(t)) at = isoNow(t + 1000); // must be strictly later than consumed
      }
      c.queue.push({ n, at });
      return { ok: true, control: c };
    }
    case "unqueue":
      c.queue = c.queue.filter((q) => q.n !== n);
      return { ok: true, control: c };
    case "skip":
      if (!c.skip.includes(n)) {
        if (c.skip.length >= MAX_SKIP) return { ok: false, field: "skip" };
        c.skip.push(n);
      }
      c.queue = c.queue.filter((q) => q.n !== n); // skip beats queue; keep the two lists consistent
      return { ok: true, control: c };
    case "unskip":
      c.skip = c.skip.filter((x) => x !== n);
      return { ok: true, control: c };
    default:
      return { ok: false, field: "action" };
  }
}

/** Strip control characters except \n (and \r -> dropped), trim, cap at 2000. */
export function sanitizeMessage(s) {
  if (typeof s !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim();
  return t.slice(0, MAX_MESSAGE).trim();
}

/** Owns ctl/control.json. All read-modify-write cycles go through lock(). */
export class ControlStore {
  constructor(ctlDir, now = Date.now) {
    this.file = path.join(ctlDir, "control.json");
    this.dir = ctlDir;
    this.now = now;
    this.tail = Promise.resolve();
    this.last = null; // last good value, used when the file on disk is unusable
  }
  read() {
    const r = readJsonSafe(this.file, 64 * 1024);
    if (r.ok) { this.last = normalizeControl(r.value); return this.last; }
    return this.last ?? normalizeControl(null);
  }
  write(control) {
    const c = { ...normalizeControl(control), updated_at: isoNow(this.now()) };
    writeJsonAtomic(this.file, c, 0o660);
    this.last = c;
    return c;
  }
  /** In-process mutex. fn may be async. */
  lock(fn) {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
