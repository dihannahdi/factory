import json, os, statistics
from functools import lru_cache
D = os.path.dirname(os.path.abspath(__file__))
gh = json.load(open(os.path.join(D, "gh2.json"), encoding="utf-8"))
rows = [json.loads(l) for l in open(os.path.join(D, "stats2.jsonl"), encoding="utf-8") if l.strip()]
now = max(r["ts"] for r in rows)
WIN = 7 * 86400
issues = {i["n"]: i for i in gh["issues"]}

# --- 1. scope: what agents can finish. Blocked counts only if its whole dependency chain is agent-workable.
AGENT_OK = {"eligible", "running", "queued", "blocked"}
HUMAN = {"failed", "taken", "ineligible", "skipped"}
deps = {n: [d for d in (i.get("deps") or []) if d in issues] for n, i in issues.items()}
@lru_cache(None)
def agent_completable(n, seen=()):
    i = issues[n]
    if i["class"] in HUMAN: return False
    return all(agent_completable(d, seen + (n,)) for d in deps[n] if d not in seen)
remaining = [n for n, i in issues.items() if i["class"] in AGENT_OK]
doable = [n for n in remaining if agent_completable(n)]
waiting_human = sorted(set(remaining) - set(doable))

# --- 2. merges per issue (some issues needed two PRs)
merged = [r for r in rows if r.get("kind") == "outcome" and r.get("outcome") == "merged"]
pr_per_issue = len(merged) / max(1, len({r["issue"] for r in merged}))

# --- 3. rate per busy lane-hour over the window (busy = time a lane spent in a stage of an issue)
busy_s = sum(r.get("secs", 0) for r in rows if r.get("kind") == "stage" and r["ts"] >= now - WIN and r.get("stage") != "pick")
m_win = [r for r in merged if r["ts"] >= now - WIN]
per_lane_h = len(m_win) / max(1e-9, busy_s / 3600)
lanes = 3
rate = per_lane_h * lanes

# --- 4. critical path: longest chain among doable issues x median start->merge cycle
@lru_cache(None)
def depth(n, seen=()):
    return 1 + max((depth(d, seen + (n,)) for d in deps[n] if d not in seen and d in doable), default=0)
path = max((depth(n) for n in doable), default=0)
# cycle time: first stage record of the issue's run -> its merged outcome
first = {}
for r in rows:
    if r.get("kind") == "stage" and r.get("stage") == "pick":
        first.setdefault((r["issue"], r.get("slot")), r["ts"])
cyc = []
for m in merged:
    starts = [t for (i, s), t in first.items() if i == m["issue"] and t <= m["ts"]]
    if starts: cyc.append((m["ts"] - max(starts)) / 3600)
cyc_med = statistics.median(cyc) if cyc else None
cyc_p80 = sorted(cyc)[int(0.8 * (len(cyc) - 1))] if cyc else None

work = len(doable) * pr_per_issue
eta_cap = work / rate
eta_path = path * cyc_med if cyc_med else 0
old = len(remaining) / (len([r for r in merged if r["ts"] >= now - 2 * 86400]) / 48)
print(f"old formula: {len(remaining)} / (merges48/48) = {old:.1f} h")
print(f"scope: remaining={len(remaining)} doable={len(doable)} waiting_on_humans={len(waiting_human)} {waiting_human[:12]}")
print(f"merges per issue = {pr_per_issue:.2f} ({len(merged)} merges, {len({r['issue'] for r in merged})} issues)")
print(f"busy lane-hours (7d) = {busy_s/3600:.1f}; merges (7d) = {len(m_win)}; per busy lane-hour = {per_lane_h:.3f}; x{lanes} lanes = {rate:.2f}/h")
print(f"critical path = {path} issues; cycle median = {cyc_med:.2f} h, p80 = {cyc_p80:.2f} h (n={len(cyc)})")
print(f"ETA capacity = {work:.1f} merges / {rate:.2f} = {eta_cap:.1f} h; ETA path = {eta_path:.1f} h")
print(f"ETA (P50) = max = {max(eta_cap, eta_path):.1f} h = {max(eta_cap, eta_path)/24:.1f} d")
p90_rate = rate * (cyc_med / cyc_p80) if cyc_p80 else rate
print(f"ETA (pessimistic, p80 cycle) = {max(work / p90_rate, path * cyc_p80):.1f} h")

# --- 5. list-scheduling simulation over the real dependency graph: 3 lanes, each issue costs the
# observed busy lane-hours per merge x merges per issue (failures and retries included)
import heapq
def simulate(cost, lanes=3):
    done_at, running, t = {}, [], 0.0
    pending = set(doable)
    while pending or running:
        ready = sorted(n for n in pending if all(d in done_at and done_at[d] <= t for d in deps[n] if d in doable))
        while ready and len(running) < lanes:
            n = ready.pop(0); pending.discard(n); heapq.heappush(running, (t + cost, n))
        if not running: break  # unreachable unless a cycle remains
        t, n = heapq.heappop(running); done_at[n] = t
    return t, len(done_at)
cost = (1 / per_lane_h) * pr_per_issue
mk, n_done = simulate(cost)
print(f"simulation: {cost:.2f} lane-h per issue, 3 lanes -> {mk:.1f} h = {mk/24:.1f} d ({n_done}/{len(doable)} issues)")
mk80, _ = simulate(cost * (cyc_p80 / cyc_med))
print(f"simulation pessimistic (x p80/median): {mk80:.1f} h = {mk80/24:.1f} d")
