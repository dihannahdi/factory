// ETA v2 and the waste ratio (SCHEMA section 5.3). Pure: no IO, everything arrives as parameters.
const DAY = 86400;
const WINDOW_S = 7 * DAY;
const DOABLE_FROM = new Set(["queued", "eligible", "running", "blocked"]);
const NEEDS_HUMAN = new Set(["failed", "taken", "ineligible", "skipped"]);
const PRODUCTIVE = new Set(["pr", "merged", "adopted"]);
export const MAX_LANES = 3;
export const MIN_MERGES_7D = 3;
export const MIN_Q_ISSUES = 5;
export const MIN_RATE_DAYS = 3;
export const Z80 = 0.8416; // standard normal 80th percentile, inverse Phi(0.8)

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const countable = (st) => st.stage !== "pick" && Number.isFinite(st.secs) && st.secs >= 0;

/** Linear-interpolated quantile of a number list (p in 0..1). */
export function quantile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/**
 * Doable = open work of class queued|eligible|running|blocked whose dependency closure (restricted to
 * issues present in github.json) holds no failed|taken|ineligible|skipped issue and no dependency cycle.
 * The rest of those four classes is waiting on a human: a cycle can only be broken by one.
 */
export function scopeIssues(issues) {
  const by = new Map();
  for (const i of issues) if (Number.isInteger(i?.n)) by.set(i.n, i);
  const deps = new Map();
  const dependents = new Map([...by.keys()].map((n) => [n, []]));
  for (const [n, i] of by) {
    const ds = [...new Set(Array.isArray(i.deps) ? i.deps : [])].filter((d) => by.has(d) && d !== n);
    deps.set(n, ds);
    for (const d of ds) dependents.get(d).push(n);
  }
  // An issue on a dependency cycle never starts (#23 <-> #58, 2026-10-18); the simulation would drop
  // it and everything under it without a word, which made P50 a third too short.
  const onCycle = (n) => {
    const seen = new Set(), st = [...deps.get(n)];
    while (st.length) {
      const x = st.pop();
      if (x === n) return true;
      if (!seen.has(x)) { seen.add(x); st.push(...deps.get(x)); }
    }
    return false;
  };
  // Taint every issue that has a human-class or cyclic issue anywhere under it (reverse reachability).
  const tainted = new Set();
  const stack = [...by].filter(([n, i]) => NEEDS_HUMAN.has(i.class) || onCycle(n)).map(([n]) => n);
  for (const n of stack) tainted.add(n);
  while (stack.length) for (const k of dependents.get(stack.pop())) if (!tainted.has(k)) { tainted.add(k); stack.push(k); }
  const doable = [], waiting = [];
  for (const [n, i] of by) {
    if (!DOABLE_FROM.has(i.class)) continue;
    (tainted.has(n) ? waiting : doable).push(n);
  }
  doable.sort((a, b) => a - b); waiting.sort((a, b) => a - b);
  return { doable, deps, waiting_human: waiting.map((n) => ({ n, tag: by.get(n).tag ?? null })), by };
}

/** Σ stage secs (excluding pick) of every issue that has a merged outcome and no adopted outcome, in lane-hours. */
export function effortByIssue(reader) {
  const merged = new Set(), adopted = new Set();
  for (const o of reader.outcomes) {
    if (o.outcome === "merged") merged.add(o.issue);
    else if (o.outcome === "adopted") adopted.add(o.issue);
  }
  const secs = new Map();
  for (const st of reader.stages) {
    if (st.issue == null || !merged.has(st.issue) || adopted.has(st.issue) || !countable(st)) continue;
    secs.set(st.issue, (secs.get(st.issue) ?? 0) + st.secs);
  }
  const out = new Map();
  for (const [n, s] of secs) if (s > 0) out.set(n, s / 3600);
  return out;
}

/**
 * List scheduling on `lanes` lanes. cost: Map n -> hours. An issue becomes ready when every doable
 * dependency has finished; among ready issues the one with the longest chain below it goes first, so
 * a long chain is never starved behind independent short work. Returns the makespan in hours.
 */
export function simulate(doable, deps, cost, lanes) {
  const set = new Set(doable);
  const kids = new Map(doable.map((n) => [n, []]));
  for (const n of doable) for (const d of deps.get(n) ?? []) if (set.has(d)) kids.get(d).push(n);
  const tail = new Map();
  const tailOf = (n, path = new Set()) => {
    if (tail.has(n)) return tail.get(n);
    if (path.has(n)) return 0;
    path.add(n);
    let best = 0;
    for (const k of kids.get(n)) best = Math.max(best, tailOf(k, path));
    path.delete(n);
    const v = cost.get(n) + best;
    tail.set(n, v);
    return v;
  };
  for (const n of doable) tailOf(n);
  const pending = new Set(doable), doneAt = new Map(), running = [];
  let t = 0;
  while (pending.size || running.length) {
    const ready = [...pending]
      .filter((n) => (deps.get(n) ?? []).every((d) => !set.has(d) || (doneAt.has(d) && doneAt.get(d) <= t)))
      .sort((a, b) => tail.get(b) - tail.get(a) || a - b);
    while (ready.length && running.length < lanes) {
      const n = ready.shift();
      pending.delete(n);
      running.push({ end: t + cost.get(n), n });
    }
    if (!running.length) break; // what is left sits in a dependency cycle and can never start
    running.sort((a, b) => a.end - b.end || a.n - b.n);
    const f = running.shift();
    t = f.end;
    doneAt.set(f.n, t);
  }
  return t;
}

/** min(control.agents, every slot's effective_agents, 3), at least 1. */
export function effectiveLanes(control, slots) {
  let l = MAX_LANES;
  if (Number.isFinite(control?.agents)) l = Math.min(l, control.agents);
  for (const s of slots ?? []) if (Number.isFinite(s?.effective_agents) && s.effective_agents > 0) l = Math.min(l, s.effective_agents);
  return Math.max(1, l);
}

/**
 * Day-to-day overdispersion phi of the merge rate over the last 7 days (quasi-Poisson). The window is cut
 * into 24 h buckets ending at nowS. A bucket with no busy time has no exposure: its merges go to the next
 * bucket that has some (the last such bucket takes what is left over). phi = Pearson chi-square / (buckets - 1)
 * with expected merges c x busy_d, at least 1 (a steady Poisson process); 1 with fewer than 3 buckets.
 */
export function rateDispersion(reader, nowS, c) {
  const since = nowS - WINDOW_S;
  const m = new Array(7).fill(0), b = new Array(7).fill(0);
  const day = (ts) => Math.min(6, Math.floor((ts - since) / DAY));
  for (const o of reader.outcomes) if (o.outcome === "merged" && o.ts >= since) m[day(o.ts)]++;
  for (const st of reader.stages) if (st.ts >= since && countable(st)) b[day(st.ts)] += st.secs / 3600;
  const buckets = [];
  let carry = 0;
  for (let i = 0; i < 7; i++) {
    if (b[i] > 0) { buckets.push({ m: m[i] + carry, b: b[i] }); carry = 0; } else carry += m[i];
  }
  if (carry && buckets.length) buckets[buckets.length - 1].m += carry;
  if (buckets.length < MIN_RATE_DAYS) return { phi: 1, days: buckets.length };
  let x2 = 0;
  for (const k of buckets) x2 += (k.m - c * k.b) ** 2 / (c * k.b);
  return { phi: Math.max(1, x2 / (buckets.length - 1)), days: buckets.length };
}

export const NO_SIZE_MODEL = { active: false, feature: null, n: 0, flat_mae: null, mae: null };

/**
 * ETA v2. reader: {outcomes, stages}; opts: {control, slots, size}. size, when given, is
 * {model, factor(issue) -> number|null}: factor is the issue's predicted effort relative to the
 * calibration mean (null = no features, use the flat cost).
 * Returns {eta: object|null, doable, waiting_human, q}. P80 = the simulation with every cost x
 * max(q_effort, q_rate): q_effort from how unevenly completed issues took effort (null below 5 of them),
 * q_rate from how uncertain the merge rate is, given its day-to-day dispersion.
 */
export function computeEta(reader, github, nowS, opts = {}) {
  const scope = scopeIssues(github?.issues ?? []);
  const sizeModel = opts.size?.model ?? NO_SIZE_MODEL;
  const merged = reader.outcomes.filter((o) => o.outcome === "merged");
  const mergedIssues = new Set(merged.map((o) => o.issue));
  const mpi = merged.length ? Math.max(1, merged.length / mergedIssues.size) : 1;
  const since = nowS - WINDOW_S;
  const merged7 = merged.filter((o) => o.ts >= since).length;
  let busy = 0;
  for (const st of reader.stages) if (st.ts >= since && countable(st)) busy += st.secs;
  const busyH = busy / 3600;
  const lanes = effectiveLanes(opts.control, opts.slots);
  const base = { eta: null, doable: scope.doable.length, waiting_human: scope.waiting_human, q: null, busy_h: busyH, merges_per_issue: mpi };
  if (merged7 < MIN_MERGES_7D || !(busyH > 0)) return base;
  const c = merged7 / busyH;

  const efforts = [...effortByIssue(reader).values()];
  let q = null;
  if (efforts.length >= MIN_Q_ISSUES) {
    const e50 = quantile(efforts, 0.5), e80 = quantile(efforts, 0.8);
    if (e50 > 0) q = Math.max(1, e80 / e50);
  }
  const flat = mpi / c;
  const cost = new Map();
  for (const n of scope.doable) {
    const f = sizeModel.active ? opts.size.factor(scope.by.get(n)) : null;
    cost.set(n, Number.isFinite(f) && f > 0 ? flat * f : flat);
  }
  // The rate itself is uncertain: it was measured from merged7 merges, and the remaining work is
  // nFuture more. With day-to-day dispersion phi both relative variances are phi / count; they add in
  // log space and give the pessimistic (P80) factor on time.
  const nFuture = scope.doable.length * mpi;
  const { phi, days } = rateDispersion(reader, nowS, c);
  const qRate = Math.exp(Z80 * Math.sqrt(phi * (1 / merged7 + (nFuture > 0 ? 1 / nFuture : 0))));
  const q80 = Math.max(q ?? 1, qRate);
  const p50 = simulate(scope.doable, scope.deps, cost, lanes);
  const p80 = simulate(scope.doable, scope.deps, new Map([...cost].map(([n, v]) => [n, v * q80])), lanes);
  return {
    ...base, q, c,
    eta: {
      p50_h: round(p50, 1), p80_h: round(p80, 1), lanes, rate_per_lane_h: round(c, 3),
      merges_per_issue: round(mpi, 3), doable: scope.doable.length, waiting_human: scope.waiting_human,
      size_model: sizeModel,
      q_effort: q === null ? null : round(q, 3), q_rate: round(qRate, 3),
      dispersion: days >= MIN_RATE_DAYS ? round(phi, 2) : null, // null: too few days to measure; phi = 1 is used
    },
  };
}

/**
 * Waste per productive hour over runs that ended in the last 7 days. A run is the stage records a
 * slot accumulated (pick excluded) up to its next outcome record; the outcome ts is its end. Stage
 * records after a slot's last outcome are a run still in progress and are ignored. Runs ending in
 * pr|merged|adopted are productive, every other outcome is waste. Approximation: a run ending in
 * "pr" counts as productive even when that PR is closed later.
 */
export function computeWaste(reader, nowS) {
  const ev = [];
  for (const o of reader.outcomes) ev.push({ seq: o.seq, slot: o.slot, o });
  for (const s of reader.stages) ev.push({ seq: s.seq, slot: s.slot, s });
  ev.sort((a, b) => a.seq - b.seq);
  const acc = new Map();
  let productive = 0, waste = 0;
  const since = nowS - WINDOW_S;
  for (const e of ev) {
    if (e.s) {
      if (countable(e.s)) acc.set(e.slot, (acc.get(e.slot) ?? 0) + e.s.secs);
      continue;
    }
    const secs = acc.get(e.slot) ?? 0;
    acc.set(e.slot, 0);
    if (e.o.ts < since) continue;
    if (PRODUCTIVE.has(e.o.outcome)) productive += secs; else waste += secs;
  }
  return productive > 0 ? round(waste / productive, 2) : null;
}
