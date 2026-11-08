// The dependency map: every issue github.json knows, open and closed, laid out as a flow from what came
// first to what still waits. Pure: github.json issues and done in, nodes, edges and layers out.
import type { GhDone, GhIssue, IssueClass } from "./types";

/**
 * running: a lane works it now. ready: queued or eligible, nothing open blocks it.
 * waiting: blocked, and every chain under it ends in work an agent can do, so it opens by itself.
 * stuck: blocked, and somewhere under it is a human-class issue, a cycle, or a bare agent-blocked label.
 * human: failed, taken, skipped or ineligible itself. cycle: on a dependency cycle of open issues.
 * done: closed.
 */
export type NodeState = "running" | "ready" | "waiting" | "stuck" | "human" | "cycle" | "done";
export const STATES: NodeState[] = ["running", "ready", "waiting", "stuck", "human", "cycle", "done"];

const HUMAN = new Set<IssueClass>(["failed", "taken", "skipped", "ineligible"]);

export interface MapNode {
  n: number;
  tag: string;
  title: string;
  milestone: string | null;
  /** the classifier's class; "closed" for a done issue */
  cls: IssueClass | "closed";
  /** the classifier's reason (e.g. "label agent-failed", "open PR #131"); the close reason when done */
  reason: string;
  state: NodeState;
  closedAt: number | null;
  /** open issues that hold this one back now */
  deps: number[];
  /** every other dependency it ever declared, already closed (or, for a closed issue, all of them) */
  past: number[];
  /** issues that depend on this one, open or closed */
  dependents: number[];
  /** distinct issues that depend on this one, directly or through others */
  unblocks: number;
  /** layer: 0 = depends on nothing drawn; a cycle shares one layer */
  rank: number;
  /** position inside the layer */
  pos: number;
}
/** live: the dependency still holds `to` back (an open dep of an open issue); otherwise history. */
export interface MapEdge { from: number; to: number; cycle: boolean; live: boolean }
export interface DepMap {
  /** issues with at least one dependency edge, in layers */
  nodes: MapNode[];
  edges: MapEdge[];
  layers: number;
  /** the largest layer, for sizing */
  width: number;
  /** issues with no edge at all */
  free: MapNode[];
  /** cycles among open issues: live deadlocks */
  cycles: number[][];
  summary: Record<NodeState, number>;
}

/** Strongly connected components with more than one member (Tarjan). */
function cyclesOf(ids: number[], deps: Map<number, number[]>): number[][] {
  let index = 0;
  const idx = new Map<number, number>(), low = new Map<number, number>(), on = new Set<number>(), stack: number[] = [];
  const out: number[][] = [];
  const visit = (v: number) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); on.add(v);
    for (const w of deps.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: number[] = [];
      let w: number;
      do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort((a, b) => a - b));
    }
  };
  for (const v of ids) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => a[0] - b[0]);
}

function closure(start: number, next: Map<number, number[]>): Set<number> {
  const seen = new Set<number>(), st = [...(next.get(start) ?? [])];
  while (st.length) {
    const x = st.pop()!;
    if (x === start || seen.has(x)) continue;
    seen.add(x);
    st.push(...(next.get(x) ?? []));
  }
  return seen;
}

const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);

export function buildDepMap(issues: GhIssue[], done: GhDone[] = []): DepMap {
  const open = new Map<number, GhIssue>();
  for (const i of issues) if (Number.isInteger(i?.n)) open.set(i.n, i);
  const closed = new Map<number, GhDone>();
  for (const d of done) if (Number.isInteger(d?.n) && !open.has(d.n)) closed.set(d.n, d);
  const known = (k: number) => open.has(k) || closed.has(k);
  const openIds = [...open.keys()].sort((a, b) => a - b);
  const ids = [...open.keys(), ...closed.keys()].sort((a, b) => a - b);

  // Live graph: open issues and the open deps that hold them back. States and deadlocks come from it.
  const liveDeps = new Map<number, number[]>(), liveDependents = new Map<number, number[]>(openIds.map((n) => [n, []]));
  for (const n of openIds) {
    const ds = [...new Set(ints(open.get(n)!.deps))].filter((d) => d !== n && open.has(d)).sort((a, b) => a - b);
    liveDeps.set(n, ds);
    for (const d of ds) liveDependents.get(d)!.push(n);
  }
  // Full graph: everything any issue ever declared, open or closed. Layers and history come from it.
  const allDeps = new Map<number, number[]>(), allDependents = new Map<number, number[]>(ids.map((n) => [n, []]));
  for (const n of ids) {
    const raw = open.has(n) ? [...ints(open.get(n)!.deps_all), ...ints(open.get(n)!.deps)] : ints(closed.get(n)!.deps);
    const ds = [...new Set(raw)].filter((d) => d !== n && known(d)).sort((a, b) => a - b);
    allDeps.set(n, ds);
    for (const d of ds) allDependents.get(d)!.push(n);
  }

  const cycles = cyclesOf(openIds, liveDeps);
  const inCycle = new Set(cycles.flat());
  const roots = openIds.filter((n) => {
    const c = open.get(n)!.class;
    return HUMAN.has(c) || inCycle.has(n) || (c === "blocked" && liveDeps.get(n)!.length === 0);
  });
  const tainted = new Set<number>(roots);
  const st = [...roots];
  while (st.length) for (const k of liveDependents.get(st.pop()!)!) if (!tainted.has(k)) { tainted.add(k); st.push(k); }

  const stateOf = (n: number): NodeState => {
    if (closed.has(n)) return "done";
    const c = open.get(n)!.class;
    if (inCycle.has(n)) return "cycle";
    if (c === "running") return "running";
    if (HUMAN.has(c)) return "human";
    if (c === "blocked") return tainted.has(n) ? "stuck" : "waiting";
    return "ready";
  };

  // Layers on the full graph with every cycle (live or historical) collapsed: longest chain under it.
  const compOf = new Map<number, number>(ids.map((n) => [n, n]));
  for (const c of cyclesOf(ids, allDeps)) for (const n of c) compOf.set(n, c[0]);
  const comps = [...new Set(ids.map((n) => compOf.get(n)!))];
  const cdeps = new Map<number, Set<number>>(comps.map((c) => [c, new Set()]));
  for (const n of ids) for (const d of allDeps.get(n)!) if (compOf.get(d) !== compOf.get(n)) cdeps.get(compOf.get(n)!)!.add(compOf.get(d)!);
  const crank = new Map<number, number>();
  const rankOf = (c: number, path = new Set<number>()): number => {
    if (crank.has(c)) return crank.get(c)!;
    if (path.has(c)) return 0;
    path.add(c);
    let r = 0;
    for (const d of cdeps.get(c)!) r = Math.max(r, rankOf(d, path) + 1);
    path.delete(c);
    crank.set(c, r);
    return r;
  };

  const linked = new Set(ids.filter((n) => allDeps.get(n)!.length > 0 || allDependents.get(n)!.length > 0));
  const node = (n: number): MapNode => {
    const o = open.get(n), c = closed.get(n);
    const live = liveDeps.get(n) ?? [];
    return {
      n, tag: (o ?? c)!.tag ?? `#${n}`, title: (o ?? c)!.title, milestone: (o ?? c)!.milestone,
      cls: o ? o.class : "closed", reason: o ? o.reason ?? "" : c!.reason, state: stateOf(n),
      closedAt: c ? c.closed_at : null,
      deps: live, past: allDeps.get(n)!.filter((d) => !live.includes(d)),
      dependents: [...allDependents.get(n)!].sort((a, b) => a - b),
      unblocks: closure(n, allDependents).size, rank: rankOf(compOf.get(n)!), pos: 0,
    };
  };
  const nodes = ids.filter((n) => linked.has(n)).map(node);
  const free = ids.filter((n) => !linked.has(n)).map(node);

  // Order inside each layer: milestone, then number; then a few barycenter sweeps against the
  // neighbours' positions so edges cross less. Deterministic: ties fall back to the number.
  const layers = nodes.reduce((m, x) => Math.max(m, x.rank + 1), 0);
  const byRank: MapNode[][] = Array.from({ length: layers }, () => []);
  for (const x of nodes) byRank[x.rank].push(x);
  for (const row of byRank) {
    row.sort((a, b) => (a.milestone ?? "~").localeCompare(b.milestone ?? "~") || a.n - b.n);
    row.forEach((x, i) => (x.pos = i));
  }
  const at = new Map(nodes.map((x) => [x.n, x]));
  const bary = (x: MapNode, nb: number[]) => {
    const ps = nb.map((k) => at.get(k)).filter((y): y is MapNode => !!y).map((y) => y.pos / Math.max(1, byRank[y.rank].length - 1));
    return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : x.pos / Math.max(1, byRank[x.rank].length - 1);
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? byRank.map((_, i) => i) : byRank.map((_, i) => layers - 1 - i);
    for (const r of order) {
      const key = new Map(byRank[r].map((x) => [x.n, bary(x, down ? allDeps.get(x.n)! : x.dependents)]));
      byRank[r].sort((a, b) => key.get(a.n)! - key.get(b.n)! || a.n - b.n);
      byRank[r].forEach((x, i) => (x.pos = i));
    }
  }

  const edges: MapEdge[] = [];
  for (const x of nodes) for (const d of allDeps.get(x.n)!) {
    const live = x.deps.includes(d);
    edges.push({ from: d, to: x.n, live, cycle: live && inCycle.has(d) && inCycle.has(x.n) && cycles.some((c) => c.includes(d) && c.includes(x.n)) });
  }

  const summary = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<NodeState, number>;
  for (const x of [...nodes, ...free]) summary[x.state]++;
  return { nodes, edges, layers, width: byRank.reduce((m, r) => Math.max(m, r.length), 0), free, cycles, summary };
}

/** Everything under n (what it waited for, transitively) and everything over it (what it opens). */
export function chainOf(map: DepMap, n: number): { up: Set<number>; down: Set<number> } {
  const all = [...map.nodes, ...map.free];
  const deps = new Map(all.map((x) => [x.n, [...x.deps, ...x.past]]));
  const dependents = new Map(all.map((x) => [x.n, x.dependents]));
  return { up: closure(n, deps), down: closure(n, dependents) };
}

/** A close date in the viewer's own locale and time zone. */
const dateOf = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** One sentence on why a node is where it is. */
export function whyText(map: DepMap, x: MapNode): string {
  const all = [...map.nodes, ...map.free];
  const tag = (k: number) => all.find((y) => y.n === k)?.tag ?? `#${k}`;
  const list = (ks: number[]) => ks.map(tag).join(", ");
  switch (x.state) {
    case "running": return "A lane is working on it.";
    case "ready": return x.cls === "queued" ? "Ready, queued by a human: picked up first." : "Ready: waits on no open issue.";
    case "waiting": return `Waiting on ${list(x.deps)}; opens by itself once they all merge.`;
    case "stuck": {
      if (x.deps.length === 0) return "Labeled agent-blocked with no open dependencies: a human has to release it.";
      const blockers = [...chainOf(map, x.n).up].filter((k) => {
        const y = all.find((z) => z.n === k);
        return y && (y.state === "human" || y.state === "cycle");
      });
      return `Stuck: its chain depends on ${list(blockers.sort((a, b) => a - b))}, which needs a human decision.`;
    }
    case "human": {
      const opens = x.unblocks ? ` Holds back ${x.unblocks} ${x.unblocks === 1 ? "issue" : "issues"} above it.` : "";
      if (x.cls === "failed") return `Failed in the pipeline (${x.reason || "agent-failed"}). Requeue it from Issue actions once the cause is fixed.${opens}`;
      if (x.cls === "taken") return `Taken by a human: ${x.reason || "open PR"}.${opens}`;
      if (x.cls === "skipped") return `Skipped at a human's request.${opens}`;
      return `Outside the pipeline: ${x.reason || "not eligible"}.${opens}`;
    }
    case "cycle": return `Waiting on each other in a cycle (${list(map.cycles.find((c) => c.includes(x.n)) ?? [])}): only a human can break it.`;
    case "done": {
      const when = x.closedAt != null ? ` ${dateOf(x.closedAt)}` : "";
      const how = x.reason === "not_planned" ? "Closed as not planned" : "Done";
      const k = x.dependents.length;
      const opened = k === 0 ? "" : k <= 3 ? ` Unblocked ${list(x.dependents)}.` : ` Unblocked ${k} issues.`;
      return `${how}${when}.${opened}`;
    }
  }
}
