// Small pure formatters shared by readouts. Numbers go to mono type, so keep them compact and stable.
import type { EtaInfo, Tokens, TokensTotal } from "./types";

/** 42s · 3m05s · 1h02m. Null, NaN and negatives (clock skew) read as an em dash or 0s. */
export function fmtElapsed(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** ETA in hours from metrics.eta_h. Null means "not enough merges to say", shown as a dash. */
export function fmtEta(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 10) return `${h.toFixed(1)}h`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Fixed one/two decimals: 0.8 */
const d1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);
const d2 = (x: number): string => (Math.round(x * 100) / 100).toFixed(2);

/** Pulse ETA tile: "4–7 days" from P50/P80, just P50 when P80 is null, a dash when there is no estimate. */
export function fmtEtaRange(p50: number | null | undefined, p80: number | null | undefined): string {
  if (p50 == null || !Number.isFinite(p50)) return "—";
  const hi = p80 != null && Number.isFinite(p80) && p80 > p50 ? p80 : null;
  const span = (a: number, b: number | null, unit: string): string => {
    const x = Math.max(1, Math.round(a)), y = b == null ? x : Math.max(x, Math.round(b));
    return y > x ? `${x}–${y} ${unit}` : `${x} ${unit}`;
  };
  if (p50 < 1) return `${Math.max(1, Math.round(p50 * 60))} min`;
  if (p50 < 48) return span(p50, hi, "h");
  return span(p50 / 24, hi == null ? null : hi / 24, "days");
}

/** Waste tile: hours thrown away per productive hour, one decimal. */
export function fmtWaste(w: number | null | undefined): string {
  return w == null || !Number.isFinite(w) ? "—" : d1(w);
}

/** Tooltip of the ETA tile. */
export function etaTip(m: { eta: EtaInfo | null } | null | undefined): string {
  const e = m?.eta;
  if (!e) return "time to finish (needs ≥ 3 merges in 7 days)";
  const sm = e.size_model;
  const size = sm.active ? `size: ${sm.feature} (n=${sm.n})` : `size: average (n=${sm.n}/30)`;
  const wait = e.waiting_human.length ? e.waiting_human.map((w) => w.tag ?? `#${w.n}`).join(" ") : "none";
  const rate = Math.round(e.rate_per_lane_h * 1000) / 1000;
  const qr = e.q_rate ?? 0, qe = e.q_effort ?? 0;
  const why = qr || qe
    ? [qr >= qe
      ? `P80 ×${d2(qr)}: rate still uncertain (${e.dispersion == null ? "daily dispersion not measured yet" : `daily dispersion ${d1(e.dispersion)}`})`
      : `P80 ×${d2(qe)}: issue sizes are uneven`]
    : [];
  return [
    `P50 ${d1(e.p50_h)} h · P80 ${e.p80_h == null ? "—" : `${d1(e.p80_h)} h`}`,
    ...why,
    `${e.doable} issues doable by agents`,
    `waiting on a human: ${wait}`,
    `${rate} merges per lane-hour × ${e.lanes} lanes`,
    size,
  ].join("\n");
}

/** Tooltip of the tokens tile: what the big number counts, and the parts it leaves out. */
export function tokensTip(total: TokensTotal | null | undefined, today: number | null): string {
  const day = `today ${fmtNum(today)}`;
  if (!total) return `tokens today: input + output`;
  const since = total.since == null ? "" : ` since ${new Date(total.since * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  return [
    `total input + output${since}`,
    `input ${fmtNum(total.input)} · output ${fmtNum(total.output)} · ${day}`,
    `not counted: reasoning ${fmtNum(total.reasoning)} · cache read ${fmtNum(total.cache_read)}`,
  ].join("\n");
}

/** 999 · 1.5k · 161k · 4.0M · 67M · 3.0B */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (a < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (a < 999_500_000) return `${(n / 1_000_000).toFixed(a < 10_000_000 ? 1 : 0)}M`; // 999.5M would round to "1000M"
  return `${(n / 1_000_000_000).toFixed(a < 10_000_000_000 ? 1 : 0)}B`;
}

/** Share of prompt tokens served from cache, 0..100. */
export function cachePct(t: Pick<Tokens, "input" | "cache_read"> | null | undefined): number {
  if (!t) return 0;
  const total = t.input + t.cache_read;
  return total > 0 ? Math.round((t.cache_read / total) * 100) : 0;
}

/** opencode/deepseek-v4.1-flash-free -> deepseek-v4.1-flash */
export function shortModel(id: string | null | undefined): string {
  if (!id) return "—";
  return id.replace(/^opencode\//, "").replace(/-free$/, "");
}

/** mm:ss countdown, floor at 0. */
export function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
}

/** "[API-01] Add the endpoint..." -> "Add the endpoint..." (the tag is shown separately). */
export function stripTag(title: string): string {
  return title.replace(/^\s*\[[A-Z0-9-]+\]\s*/, "");
}

/** Strip control characters that could mangle a one-line mono readout. */
export function oneLine(s: string | null | undefined): string {
  return (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Exponential reconnect delay in ms: 1s, 2s, 4s ... capped at 30s, with the failure count starting at 0. */
export function backoffDelay(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, failures));
}

/** 3m · 2h · 5d, for "how long ago". */
export function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor(now - ts));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Links come from the API: only plain https URLs are ever rendered as hrefs. */
export function safeUrl(u: string | null | undefined): string | null {
  return typeof u === "string" && /^https:\/\/[^\s]+$/.test(u) ? u : null;
}

/** One mono character per tool, ASCII only so no font can substitute an emoji. */
export function toolGlyph(tool: string | null | undefined): string {
  switch (tool) {
    case "bash": return "$";
    case "read": return "<";
    case "edit": return "~";
    case "write": return "+";
    case "grep": return "?";
    case "glob": case "list": return "*";
    case "todowrite": return "=";
    case "task": case "webfetch": return "@";
    default: return ">";
  }
}

export const OUTCOME_ICON: Record<string, string> = {
  merged: "check", pr: "up", waiting: "chain", blocked: "warn", no_commit: "none", verify_failed: "cross",
  ci_failed: "cross", ci_wait: "dots", conflict: "fork", guard: "shield", retry: "retry", stopped: "pause",
  adopted: "up", adopt_incomplete: "dots", adopt_moved: "retry",
};
