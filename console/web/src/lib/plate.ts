// Pure text logic for the station plate: what the machine says it is doing, in at most PLATE_COLS
// mono columns. No store, no DOM, so every rule here is unit-tested.
import type { Item } from "./types";

export const PLATE_COLS = 30;

const oneLine = (s: string | null | undefined): string => (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** Cut to `n` columns with a trailing ellipsis. */
export function clip(s: string, n: number = PLATE_COLS): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

/** Fit a plate line into `n` columns; a quoted line keeps its closing quote. */
export function fitCols(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n >= 4 && s.length > 2 && s.startsWith("“") && s.endsWith("”")) return `“${clip(s.slice(1, -1), n - 2)}”`;
  return clip(s, n);
}

/** The file name of a path, either slash style. "/a/b/db.rs" -> "db.rs". */
export function baseName(p: string): string {
  const t = oneLine(p).replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i >= 0 ? t.slice(i + 1) : t;
}

/** Short elapsed time for a waiting plate: 45s, 4m, 1h02m. */
export function fmtWait(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** Silence counter: 12s, 1m05s. Seconds stay visible so the counter visibly ticks. */
export function fmtThink(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function host(u: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(u);
  return m ? m[1].replace(/^www\./, "") : u;
}

/** One activity item as a plate line, or null when the item is not something to show (step). */
export function itemText(it: Item): string | null {
  if (it.kind === "tool") {
    const tool = oneLine(it.tool).toLowerCase() || "tool";
    const target = oneLine(it.target);
    switch (tool) {
      case "bash": return clip("$ " + (target || "…"));
      case "read": case "edit": case "write": case "patch": case "multiedit":
        return clip(`${tool === "multiedit" ? "edit" : tool} ${target ? baseName(target) : "…"}`);
      case "grep": case "glob": return clip(`${tool} ${target || "…"}`);
      case "task": return clip(`task ${target || "…"}`);
      case "webfetch": return clip(`fetch ${target ? host(target) : "…"}`);
      case "todowrite": case "todoread": return clip("todo list");
      default: return clip(target ? `${tool} ${/[\\/]/.test(target) ? baseName(target) : target}` : tool);
    }
  }
  if (it.kind === "text") {
    const t = oneLine(it.text);
    if (!t) return null;
    // “ + body + ” = PLATE_COLS; the ellipsis sits inside the quotes when the body is cut
    return `“${clip(t, PLATE_COLS - 2)}”`;
  }
  if (it.kind === "error") {
    const t = oneLine(it.text);
    return t ? clip("! " + t) : "! error";
  }
  return null;
}

/** The newest item worth showing (tool, text or error); steps are bookkeeping. */
export function latestText(items: readonly Item[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const s = itemText(items[i]);
    if (s != null) return s;
  }
  return null;
}

export interface PlateInput {
  stage: string;
  sub: string;
  turn: boolean; // a model turn is running
  items: readonly Item[];
  silence: number | null; // seconds since the last activity of this turn
  checks: number | null; // CI check count
  elapsed: number | null; // seconds in this stage
}

/**
 * What the plate says. `key` identifies the *kind* of line: while it stays the same only the text
 * changes (a ticking counter must not re-flip the plate every second).
 */
export function plateLabel(i: PlateInput): { text: string; key: string } {
  if (i.turn) {
    if (i.silence != null && i.silence > 5) return { text: `thinking · ${fmtThink(i.silence)}`, key: "thinking" };
    const t = latestText(i.items);
    if (t) return { text: t, key: t };
    return { text: `${i.stage} …`, key: "start:" + i.stage };
  }
  if (i.stage === "ci") {
    const n = i.checks ?? 0;
    return { text: n > 0 ? `ci · ${n} ${n === 1 ? "check" : "checks"}` : "ci · queued", key: "ci" };
  }
  const el = i.elapsed != null ? fmtWait(i.elapsed) : "";
  if (i.stage === "deploy") return { text: el ? `deploy · ${el}` : "deploy", key: "deploy" };
  const tail = i.sub ? clip(i.sub, PLATE_COLS - i.stage.length - 3) : el;
  return { text: tail ? `${i.stage} · ${tail}` : i.stage, key: "wait:" + i.stage };
}

const FLAP = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789#$%&*+<>/=";

/**
 * Split-flap frame. `p` runs 0..1 over the transition: characters resolve left to right, a short
 * window right behind the cursor shows flipping glyphs, and everything after it is still blank.
 * `tick` varies the flipping glyphs between frames.
 */
export function flapFrame(text: string, p: number, tick: number): string {
  if (p >= 1) return text;
  const n = text.length;
  if (n === 0) return text;
  const done = Math.floor(Math.max(0, p) * (n + 4));
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === " " && i < done) out += " ";
    else if (i < done - 4) out += c;
    else if (i < done) out += FLAP[((tick * 7 + i * 13 + ((i * i) % 5)) >>> 0) % FLAP.length];
    else out += " ";
  }
  return out;
}
