// Incremental reader for ui/stats.jsonl and the SCHEMA section 5.3 computation.
import fs from "node:fs";
import { computeEta, computeWaste } from "./eta.mjs";

const MAX_FIRST_READ = 8 * 1024 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_RECORDS = 100000;
const DAY = 86400;
export const ATTEMPT_OUTCOMES = new Set(["pr", "merged", "no_commit", "verify_failed", "ci_failed"]);
const REMAINING_CLASSES = new Set(["queued", "eligible", "running", "blocked"]);

export class StatsReader {
  constructor(file) {
    this.file = file;
    this.reset();
  }
  reset() {
    this.offset = 0;
    this.ino = null;
    this.outcomes = [];
    this.stages = [];
    this.calls = [];
    this.seq = 0; // file order across outcomes and stages (waste segmentation needs it)
    // Summed as lines arrive, so the 100,000-record window on `calls` never shortens it.
    this.totals = { input: 0, output: 0, reasoning: 0, cache_read: 0, since: null };
  }

  /** Reads appended complete lines. Returns true when new records arrived. */
  refresh() {
    let st;
    try {
      st = fs.lstatSync(this.file);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    let changed = false;
    if (st.size < this.offset || (this.ino !== null && st.ino !== this.ino)) {
      this.reset();
      changed = true;
    }
    this.ino = st.ino;
    let start = this.offset;
    let dropFirst = false;
    if (start === 0 && st.size > MAX_FIRST_READ) {
      start = st.size - MAX_FIRST_READ;
      dropFirst = true;
    }
    if (st.size <= start) return changed;
    const want = Math.min(st.size - start, MAX_CHUNK);
    const buf = Buffer.alloc(want);
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY);
      let got = 0;
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, start + got);
        if (n === 0) break;
        got += n;
      }
    } catch {
      return changed;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    let text = buf;
    let base = start;
    if (dropFirst) {
      const nl = text.indexOf(10);
      if (nl < 0) { this.offset = start + want; return changed; }
      text = text.subarray(nl + 1);
      base += nl + 1;
    }
    const lastNl = text.lastIndexOf(10);
    if (lastNl < 0) {
      this.offset = want >= MAX_CHUNK ? base + text.length : base; // skip a pathological line
      return changed;
    }
    this.offset = base + lastNl + 1; // a partial last line stays unread until it is complete
    for (const line of text.subarray(0, lastNl + 1).toString("utf8").split("\n")) {
      if (this.#ingest(line)) changed = true;
    }
    return changed;
  }

  #ingest(line) {
    if (!line.trim()) return false;
    let o;
    try { o = JSON.parse(line); } catch { return false; }
    if (!o || typeof o !== "object" || !Number.isFinite(o.ts) || typeof o.kind !== "string") return false;
    const slot = Number.isInteger(o.slot) ? o.slot : 1; // lines from before the contract have no slot
    if (o.kind === "outcome" && typeof o.outcome === "string") {
      this.outcomes.push({ seq: this.seq++, ts: o.ts, issue: o.issue ?? null, slot, outcome: o.outcome,
        model: typeof o.model === "string" ? o.model : null, url: typeof o.url === "string" ? o.url : null });
      if (this.outcomes.length > MAX_RECORDS) this.outcomes.splice(0, this.outcomes.length - MAX_RECORDS);
      return true;
    }
    if (o.kind === "stage" && typeof o.stage === "string") {
      this.stages.push({ seq: this.seq++, ts: o.ts, issue: o.issue ?? null, slot, stage: o.stage, secs: Number(o.secs), result: o.result });
      if (this.stages.length > MAX_RECORDS) this.stages.splice(0, this.stages.length - MAX_RECORDS);
      return true;
    }
    if (o.kind === "call") {
      const t = o.tokens ?? {};
      const c = { ts: o.ts, rate_limited: o.rate_limited === true,
        input: Number(t.input) || 0, output: Number(t.output) || 0, cache_read: Number(t.cache_read) || 0 };
      this.calls.push(c);
      const tot = this.totals;
      tot.input += c.input; tot.output += c.output; tot.cache_read += c.cache_read; tot.reasoning += Number(t.reasoning) || 0;
      if (Number.isFinite(o.ts) && (tot.since === null || o.ts < tot.since)) tot.since = o.ts;
      if (this.calls.length > MAX_RECORDS) this.calls.splice(0, this.calls.length - MAX_RECORDS);
      return true;
    }
    return false;
  }

  /** Last 30 outcome lines, newest first. */
  recent(n = 30) {
    return this.outcomes.slice(-n).reverse().map((o) => ({
      ts: o.ts, issue: o.issue, slot: o.slot, outcome: o.outcome, model: o.model, url: o.url }));
  }
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The zone this process runs in (TZ, or the system setting), as an IANA name. */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const fmts = new Map();
/** Wall-clock parts of epoch second t in zone tz: [year, month, day, hour, minute, second]. */
function wallParts(t, tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    fmts.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(t * 1000))) p[type] = Number(value);
  return [p.year, p.month, p.day, p.hour, p.minute, p.second];
}

/**
 * Start of the local day containing nowS in IANA zone tz (default: this process's zone), in epoch
 * seconds. DST-safe: the offset is taken at midnight itself, not at nowS, and on a day whose
 * midnight a DST jump skips, the day starts at the jump (the first second that has the date).
 */
export function dayStart(nowS, tz = localZone()) {
  const [y, mo, d] = wallParts(nowS, tz);
  const sameDay = (t) => { const q = wallParts(t, tz); return q[0] === y && q[1] === mo && q[2] === d; };
  const offset = (t) => { const q = wallParts(t, tz); return Date.UTC(q[0], q[1] - 1, q[2], q[3], q[4], q[5]) / 1000 - t; };
  const wall = Date.UTC(y, mo - 1, d) / 1000; // local midnight read as if it were UTC
  let t = wall - offset(nowS);
  t = wall - offset(t); // the offset in force at midnight, in case it changed between midnight and now
  if (t <= nowS && sameDay(t) && !sameDay(t - 1)) return t;
  // midnight does not exist (or is ambiguous) in this zone today: find the first second of the date
  let lo = Math.floor(nowS) - 2 * DAY, hi = Math.floor(nowS); // sameDay(lo) is false, sameDay(hi) is true
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (sameDay(mid)) hi = mid; else lo = mid; }
  return hi;
}

/**
 * reader: {outcomes, stages, calls}; github: parsed github.json or null; nowS: epoch seconds.
 * opts: {control, slots, size} feed ETA v2 (lib/eta.mjs); size comes from lib/sizecal.mjs.
 * opts.tz: IANA zone whose midnight resets tokens_today (HC_TZ); default this process's zone.
 */
export function computeMetrics(reader, github, nowS, opts = {}) {
  const merged = reader.outcomes.filter((o) => o.outcome === "merged");
  const merged24 = merged.filter((o) => o.ts >= nowS - DAY).length;
  const merged7d = merged.filter((o) => o.ts >= nowS - 7 * DAY).length;
  const merged48 = merged.filter((o) => o.ts >= nowS - 2 * DAY).length;
  const remaining = (github?.issues ?? []).filter((i) => REMAINING_CLASSES.has(i.class)).length;
  const throughput = merged48 / 48;
  const etaV2 = computeEta(reader, github, nowS, opts);

  const success = {};
  for (const o of reader.outcomes) {
    if (!o.model || !ATTEMPT_OUTCOMES.has(o.outcome)) continue;
    const s = (success[o.model] ??= { attempts: 0, merged: 0, rate: 0 });
    s.attempts++;
    if (o.outcome === "merged") s.merged++;
  }
  for (const s of Object.values(success)) s.rate = round(s.merged / s.attempts, 3);

  const byStage = {};
  for (const s of reader.stages) {
    if (s.result === "ok" && Number.isFinite(s.secs) && s.secs >= 0) (byStage[s.stage] ??= []).push(s.secs);
  }
  const stageMedian = {};
  let bottleneck = null, worst = -1;
  for (const [stage, xs] of Object.entries(byStage)) {
    const m = round(median(xs) / 60, 1);
    stageMedian[stage] = m;
    if (m > worst) { worst = m; bottleneck = stage; }
  }

  const today = dayStart(nowS, opts.tz);
  const tokens = { input: 0, output: 0, cache_read: 0 };
  let rl1h = 0;
  for (const c of reader.calls) {
    if (c.ts >= today) { tokens.input += c.input; tokens.output += c.output; tokens.cache_read += c.cache_read; }
    if (c.rate_limited && c.ts >= nowS - 3600) rl1h++;
  }
  return {
    merged_total: merged.length, merged_24h: merged24, merged_7d: merged7d, remaining,
    throughput_per_h: round(throughput, 3), eta_h: etaV2.eta ? etaV2.eta.p50_h : null, eta: etaV2.eta,
    waste_per_productive_h_7d: computeWaste(reader, nowS),
    success, stage_median_min: stageMedian, bottleneck,
    tokens_today: tokens, tokens_total: { ...reader.totals }, rate_limited_1h: rl1h,
  };
}
