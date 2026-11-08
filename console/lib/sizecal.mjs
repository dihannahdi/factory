// Size calibration for ETA v2. Off until it proves itself: with fewer than MIN_N completed issues, or
// when no text feature beats the flat geometric mean by 15% in leave-one-out error, every doable issue
// costs the same. Features come from the newest run dir's issue.json per issue, read only through the
// path-confined, size-capped readers (inspect.mjs / files.mjs); the console never keeps a body.
import fs from "node:fs";
import path from "node:path";
import { resolveDirInside } from "./inspect.mjs";
import { readJsonSafe } from "./files.mjs";
import { effortByIssue, NO_SIZE_MODEL } from "./eta.mjs";

export const MIN_N = 30;
export const ACTIVATE_RATIO = 0.85;
export const TTL_MS = 10 * 60 * 1000;
export const FEATURES = ["chars", "bullets", "checkboxes", "epic"];
const MIN_EFFORT_H = 0.2; // below this ln(effort) is noise (a stray stage record, not a worked issue)
const MAX_ISSUE_JSON = 2 * 1024 * 1024;
const RUN_DIR = /^issue-(\d+)-(\d{8}T\d{6}Z)(?:-s[1-3])?$/; // run.sh start_log names; the stamp sorts as text
const BULLET = /^\s*([-*]|\d+[.)])\s+\S/;
const CHECKBOX = /^\s*[-*]\s*\[[ xX]\]/;

/** Text features of an issue. body may be missing; epic comes from the title. */
export function featuresOf(body, title) {
  const text = typeof body === "string" ? body : "";
  let bullets = 0, checkboxes = 0;
  for (const line of text.split("\n")) {
    if (BULLET.test(line)) bullets++;
    if (CHECKBOX.test(line)) checkboxes++;
  }
  return { chars: text.length, bullets, checkboxes, epic: /epic/i.test(String(title ?? "")) ? 1 : 0 };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Least squares y = a + b x. A constant x gives the mean (b = 0). */
function fit(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** Leave-one-out MAE (lane-hours) of ln(effort) = a + b ln(1+feature); feature null = flat geometric mean. */
export function looMae(samples, feature) {
  let err = 0;
  for (let k = 0; k < samples.length; k++) {
    const tr = samples.filter((_, i) => i !== k);
    const ys = tr.map((s) => Math.log(s.effort));
    let pred;
    if (feature === null) pred = Math.exp(mean(ys));
    else {
      const { a, b } = fit(tr.map((s) => Math.log(1 + s.feats[feature])), ys);
      pred = Math.exp(a + b * Math.log(1 + samples[k].feats[feature]));
    }
    err += Math.abs(pred - samples[k].effort);
  }
  return err / samples.length;
}

/**
 * samples: [{effort (lane-h), feats}]. Returns {model: size_model, factor(issue) -> number|null}.
 * The model block always carries n and flat_mae; a feature is active only with n >= MIN_N and
 * MAE <= ACTIVATE_RATIO x flat MAE.
 */
export function calibrate(samples) {
  const n = samples.length;
  const model = { ...NO_SIZE_MODEL, n, flat_mae: n >= 2 ? round3(looMae(samples, null)) : null };
  const flatOnly = { model, factor: () => null };
  if (n < MIN_N) return flatOnly;
  const flat = looMae(samples, null);
  let best = null, bestMae = Infinity;
  for (const f of FEATURES) {
    const m = looMae(samples, f);
    if (m < bestMae) { best = f; bestMae = m; }
  }
  if (!(bestMae <= ACTIVATE_RATIO * flat)) return flatOnly;
  const { a, b } = fit(samples.map((s) => Math.log(1 + s.feats[best])), samples.map((s) => Math.log(s.effort)));
  const pred = (feats) => Math.exp(a + b * Math.log(1 + feats[best]));
  const avg = mean(samples.map((s) => pred(s.feats)));
  return {
    model: { ...model, active: true, feature: best, mae: round3(bestMae) },
    factor: (issue) => {
      const f = issueFeats(issue);
      return f ? pred(f) / avg : null;
    },
  };
}
const round3 = (x) => Math.round(x * 1000) / 1000;

/** Features of a github.json issue ({title, size: {chars, bullets, checkboxes}}); null when it has no size. */
export function issueFeats(issue) {
  const z = issue?.size;
  if (!z || ![z.chars, z.bullets, z.checkboxes].every((v) => Number.isFinite(v) && v >= 0)) return null;
  return { chars: z.chars, bullets: z.bullets, checkboxes: z.checkboxes, epic: /epic/i.test(String(issue.title ?? "")) ? 1 : 0 };
}

export class SizeCalibrator {
  constructor({ logDir, ttlMs = TTL_MS }) {
    this.logDir = logDir;
    this.ttlMs = ttlMs;
    this.at = -Infinity;
    this.result = { model: NO_SIZE_MODEL, factor: () => null };
    this.featCache = new Map(); // run dir name -> features, a finished run dir never changes its issue.json
  }

  /** Cached for ttlMs. reader: StatsReader (outcomes, stages). */
  get(reader, nowMs) {
    if (nowMs - this.at < this.ttlMs) return this.result;
    this.at = nowMs;
    try { this.result = calibrate(this.#samples(reader)); } catch { /* keep the previous result */ }
    return this.result;
  }

  #newestDirs(wanted) {
    const best = new Map();
    let names;
    try { names = fs.readdirSync(this.logDir); } catch { return best; }
    for (const name of names) {
      const m = RUN_DIR.exec(name);
      if (!m) continue;
      const n = Number(m[1]), ts = m[2];
      if (!wanted.has(n)) continue;
      const cur = best.get(n);
      if (!cur || ts > cur.ts) best.set(n, { ts, name });
    }
    return best;
  }

  #samples(reader) {
    const effort = new Map([...effortByIssue(reader)].filter(([, h]) => h > MIN_EFFORT_H));
    const dirs = this.#newestDirs(new Set(effort.keys()));
    const out = [];
    for (const [n, { name }] of dirs) {
      let feats = this.featCache.get(name);
      if (!feats) {
        const real = resolveDirInside(this.logDir, path.join(this.logDir, name));
        if (!real) continue;
        const r = readJsonSafe(path.join(real, "issue.json"), MAX_ISSUE_JSON);
        if (!r.ok || !r.value || typeof r.value !== "object") continue;
        feats = featuresOf(r.value.body, r.value.title);
        this.featCache.set(name, feats);
      }
      out.push({ n, effort: effort.get(n), feats });
    }
    return out;
  }
}
