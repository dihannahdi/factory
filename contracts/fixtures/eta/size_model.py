import json, os, re, math, statistics, heapq
from functools import lru_cache
D = os.path.dirname(os.path.abspath(__file__))
full = {i["number"]: i for i in json.load(open(os.path.join(D, "issues_full.json"), encoding="utf-8"))}
gh = json.load(open(os.path.join(D, "gh2.json"), encoding="utf-8"))
rows = [json.loads(l) for l in open(os.path.join(D, "stats2.jsonl"), encoding="utf-8") if l.strip()]

def feats(n):
    i = full.get(n) or {}
    body = i.get("body") or ""
    lines = body.splitlines()
    return {
        "chars": len(body),
        "checkbox": sum(1 for l in lines if re.match(r"\s*[-*]\s*\[[ xX]\]", l)),
        "bullets": sum(1 for l in lines if re.match(r"\s*([-*]|\d+[.)])\s+\S", l)),
        "epic": 1 if re.search(r"epic", i.get("title", ""), re.I) else 0,
    }

# target: lane-hours each completed issue occupied (all its stage time, failed attempts included)
merged_issues = {r["issue"] for r in rows if r.get("kind") == "outcome" and r.get("outcome") == "merged"}
adopted = {r["issue"] for r in rows if r.get("kind") == "outcome" and r.get("outcome") == "adopted"}
effort = {}
for r in rows:
    if r.get("kind") == "stage" and r.get("stage") != "pick" and r.get("issue") in merged_issues:
        effort[r["issue"]] = effort.get(r["issue"], 0) + r.get("secs", 0) / 3600
cal = sorted(n for n in effort if n not in adopted and n in full and effort[n] > 0.2)
print(f"calibration set: {len(cal)} merged, non-adopted issues")
for n in cal:
    f = feats(n); print(f"  #{n:<4} {effort[n]:5.1f} lane-h  chars={f['chars']:5d} checkbox={f['checkbox']:2d} bullets={f['bullets']:2d} epic={f['epic']}")

def loo(feature):
    """Leave-one-out MAE (hours) of log(effort) = a + b*log(1+feature); feature None = flat mean."""
    errs = []
    for k in cal:
        tr = [n for n in cal if n != k]
        ys = [math.log(effort[n]) for n in tr]
        if feature is None:
            pred = math.exp(statistics.mean(ys))
        else:
            xs = [math.log(1 + feats(n)[feature]) for n in tr]
            mx, my = statistics.mean(xs), statistics.mean(ys)
            sxx = sum((x - mx) ** 2 for x in xs)
            b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 0
            a = my - b * mx
            pred = math.exp(a + b * math.log(1 + feats(k)[feature]))
        errs.append(abs(pred - effort[k]))
    return statistics.mean(errs)

res = {"flat (no size)": loo(None)}
for f in ["chars", "checkbox", "bullets", "epic"]:
    res[f] = loo(f)
for k, v in sorted(res.items(), key=lambda kv: kv[1]):
    print(f"LOO MAE {k:16s} {v:5.2f} lane-h")
best = min((k for k in res if k != "flat (no size)"), key=lambda k: res[k])
print("best feature:", best)

# fit on all calibration points with the best feature
xs = [math.log(1 + feats(n)[best]) for n in cal]; ys = [math.log(effort[n]) for n in cal]
mx, my = statistics.mean(xs), statistics.mean(ys)
b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
a = my - b * mx
resid = [y - (a + b * x) for x, y in zip(xs, ys)]
s = statistics.pstdev(resid)
print(f"model: lane-h = exp({a:.3f} + {b:.3f} * ln(1 + {best}))   residual sd (log) = {s:.2f}")

# apply to the agent-completable backlog
issues = {i["n"]: i for i in gh["issues"]}
HUMAN = {"failed", "taken", "ineligible", "skipped"}
deps = {n: [d for d in (i.get("deps") or []) if d in issues] for n, i in issues.items()}
@lru_cache(None)
def ok(n, seen=()):
    if issues[n]["class"] in HUMAN: return False
    return all(ok(d, seen + (n,)) for d in deps[n] if d not in seen)
doable = [n for n, i in issues.items() if i["class"] in {"eligible", "running", "queued", "blocked"} and ok(n)]
pred = {n: math.exp(a + b * math.log(1 + feats(n)[best])) for n in doable}
flat = math.exp(statistics.mean(ys))
W = sum(pred.values())
print(f"backlog: {len(doable)} issues, predicted {W:.0f} lane-h (flat model would say {flat*len(doable):.0f})")
big = sorted(pred.items(), key=lambda kv: -kv[1])[:5]
print("largest:", ", ".join(f"#{n} {issues[n]['tag']} {h:.1f}h" for n, h in big))

def simulate(cost, lanes=3):
    done_at, running, t, pending = {}, [], 0.0, set(doable)
    while pending or running:
        ready = sorted((n for n in pending if all(d in done_at and done_at[d] <= t for d in deps[n] if d in doable)), key=lambda n: -cost[n])
        while ready and len(running) < lanes:
            n = ready.pop(0); pending.discard(n); heapq.heappush(running, (t + cost[n], n))
        if not running: break
        t, n = heapq.heappop(running); done_at[n] = t
    return t
p50 = simulate(pred)
p80 = simulate({n: h * math.exp(0.8416 * s) for n, h in pred.items()})
print(f"ETA (3 lanes, real dependency graph): P50 {p50:.0f} h = {p50/24:.1f} d; P80 {p80:.0f} h = {p80/24:.1f} d")

# --- plan-based size: requirements / files the plan step committed to
plans = {}
for line in open(os.path.join(D, "plans.txt"), encoding="utf-8"):
    p = line.split()
    if len(p) >= 3: plans[int(p[0])] = {"reqs": int(p[1]), "files": int(p[2])}
pc = [n for n in cal if n in plans]
def loo_plan(key):
    errs = []
    for k in pc:
        tr = [n for n in pc if n != k]
        xs = [math.log(1 + plans[n][key]) for n in tr]; ys = [math.log(effort[n]) for n in tr]
        mx, my = statistics.mean(xs), statistics.mean(ys)
        b2 = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
        errs.append(abs(math.exp(my - b2 * mx + b2 * math.log(1 + plans[k][key])) - effort[k]))
    return statistics.mean(errs), b2
flat_pc = statistics.mean(abs(math.exp(statistics.mean([math.log(effort[n]) for n in pc if n != k])) - effort[k]) for k in pc)
print(f"plan-based, n={len(pc)}: flat LOO MAE {flat_pc:.2f}")
for key in ["reqs", "files"]:
    mae, slope = loo_plan(key)
    print(f"  {key:6s} LOO MAE {mae:.2f} lane-h (slope {slope:+.2f})")
