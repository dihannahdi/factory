// Polls the root-written ui/ files once a second (fs.watch is useless here: root replaces files by
// atomic rename) and emits whole-key replacement events, exactly the shape the SSE stream needs.
import { EventEmitter } from "node:events";
import path from "node:path";
import { JsonCache } from "./files.mjs";
import { ActivityTail } from "./activity.mjs";
import { StatsReader, computeMetrics } from "./metrics.mjs";
import { SizeCalibrator } from "./sizecal.mjs";
import { DEFAULT_CONTROL, normalizeControl } from "./control.mjs";

export const STALE_AFTER_S = 120;
const METRICS_REFRESH_MS = 30000;

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export function blankSlot(k) {
  return {
    v: 1, slot: k, run_id: null, state: "parked", stage: null, sub: "", issue: null, pr: null, model: null,
    session: null, turn: null, stage_started: null, issue_started: null,
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0 }, requirements: null, ci: null,
    steer: { pending: null, last: null }, interrupt: null, note: "", effective_agents: 0, log_dir: null,
    // 0 = the lane has never written its file. The contract types `updated` as an epoch
    // number, and a null here made the frontend reject the whole snapshot on production.
    updated: 0, stale: false,
  };
}

export class State extends EventEmitter {
  constructor({ uiDir, ctlDir, logDir, readonly = false, tz, nowMs = Date.now }) {
    super();
    this.nowMs = nowMs;
    this.tz = tz; // IANA zone for the tokens_today day boundary; undefined = this process's zone
    this.readonly = readonly;
    this.slotFiles = [1, 2, 3].map((k) => new JsonCache(path.join(uiDir, "slots", `${k}.json`), { maxBytes: 256 * 1024, validate: isObj }));
    this.files = {
      github: new JsonCache(path.join(uiDir, "github.json"), { maxBytes: 4 << 20, validate: isObj }),
      models: new JsonCache(path.join(uiDir, "models.json"), { validate: isObj }),
      halt: new JsonCache(path.join(uiDir, "halt.json"), { maxBytes: 64 * 1024, validate: isObj }),
      consumed: new JsonCache(path.join(uiDir, "consumed.json"), { validate: isObj }),
      control: new JsonCache(path.join(ctlDir, "control.json"), { maxBytes: 64 * 1024, validate: isObj }),
    };
    this.stats = new StatsReader(path.join(uiDir, "stats.jsonl"));
    this.sizecal = new SizeCalibrator({ logDir });
    this.tails = [1, 2, 3].map((k) => new ActivityTail(logDir, k));
    this.data = {
      control: normalizeControl(DEFAULT_CONTROL), slots: [1, 2, 3].map(blankSlot),
      activity: { 1: [], 2: [], 3: [] }, github: null, models: null, halt: null, consumed: {},
      metrics: null, recent: [],
    };
    this.lastJson = {};
    this.lastMetricsAt = 0;
    this.timer = null;
  }

  start(intervalMs = 1000) {
    this.poll();
    this.timer = setInterval(() => { try { this.poll(); } catch (e) { console.error("poll failed:", e.message); } }, intervalMs);
    this.timer.unref?.();
    return this;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  #emit(name, value, key = name) {
    const s = JSON.stringify(value);
    if (this.lastJson[key] === s) return;
    this.lastJson[key] = s;
    this.emit("event", name, value);
  }

  poll() {
    const nowMs = this.nowMs();
    const nowS = Math.floor(nowMs / 1000);

    const changedKeys = new Set();
    for (const [key, f] of Object.entries(this.files)) {
      if (f.refresh()) changedKeys.add(key);
    }
    const D = this.data;
    D.control = normalizeControl(this.files.control.value);
    D.github = this.files.github.value;
    D.models = this.files.models.value;
    D.halt = this.files.halt.value;
    D.consumed = this.files.consumed.value ?? {};
    for (const key of ["control", "github", "models", "halt", "consumed"]) this.#emit(key, D[key]);

    for (let i = 0; i < 3; i++) {
      this.slotFiles[i].refresh();
      const raw = this.slotFiles[i].value;
      let slot = blankSlot(i + 1);
      if (raw) {
        slot = { ...raw, slot: i + 1 };
        slot.stale = slot.run_id != null && !(typeof slot.updated === "number" && nowS - slot.updated <= STALE_AFTER_S);
      }
      D.slots[i] = slot;
      this.#emit("slot", slot, `slot${i + 1}`);
    }

    for (let i = 0; i < 3; i++) {
      const r = this.tails[i].poll(D.slots[i].turn?.events);
      D.activity[i + 1] = this.tails[i].items;
      if (r) this.emit("event", "activity", r);
    }

    const statsChanged = this.stats.refresh();
    if (statsChanged) { D.recent = this.stats.recent(30); this.#emit("recent", D.recent); }
    if (statsChanged || changedKeys.has("github") || D.metrics === null || nowMs - this.lastMetricsAt >= METRICS_REFRESH_MS) {
      this.lastMetricsAt = nowMs;
      D.metrics = computeMetrics(this.stats, D.github, nowS, {
        control: D.control, slots: D.slots, size: this.sizecal.get(this.stats, nowMs), tz: this.tz,
      });
      this.#emit("metrics", D.metrics);
    }
  }

  snapshot() {
    const D = this.data;
    return {
      v: 1, now: Math.floor(this.nowMs() / 1000), readonly: this.readonly,
      control: D.control, slots: D.slots, activity: D.activity,
      github: D.github, models: D.models, halt: D.halt, consumed: D.consumed,
      metrics: D.metrics, recent: D.recent,
    };
  }

  /** Every id control.models may name: models.json free + paid (paid exists only while the Go key is installed). */
  freeModelIds() {
    const free = this.data.models?.free;
    if (!Array.isArray(free)) return null;
    const paid = Array.isArray(this.data.models?.paid) ? this.data.models.paid : [];
    return new Set([...free, ...paid].map((m) => m?.id).filter((x) => typeof x === "string"));
  }
}
