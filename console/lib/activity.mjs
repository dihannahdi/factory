// Tails the opencode JSON-lines file of a slot's running turn and turns it into Activity items
// (SCHEMA section 5.2). The path comes from a root-written slot file, but it is still validated:
// it must stay inside HC_LOG_DIR, carry no "..", and be a regular, non-symlink file.
import fs from "node:fs";
import path from "node:path";

export const MAX_ITEMS = 50;
export const FIRST_TAIL_BYTES = 256 * 1024;
const MAX_READ = 2 * 1024 * 1024;

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f]+/g;
const clean = (s, max) => String(s ?? "").replace(CTRL, " ").trim().slice(0, max);
const WORK_PREFIX = /^\/home\/factory\/(?:s[1-3]\/)?work\//;

/** Returns the resolved absolute path when it is acceptable, else null. */
export function safeEventsPath(logDir, p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 1024 || p.includes("\0")) return null;
  if (!path.isAbsolute(p)) return null;
  if (p.split(/[\\/]/).includes("..")) return null;
  const resolved = path.resolve(p);
  const rel = path.relative(path.resolve(logDir), resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

function firstLine(s) {
  return String(s ?? "").split("\n")[0];
}

function toolTarget(tool, state) {
  const input = state?.input && typeof state.input === "object" ? state.input : {};
  let t;
  switch (tool) {
    case "bash": t = firstLine(input.command); break;
    case "read": case "edit": case "write":
      t = typeof input.filePath === "string" ? input.filePath.replace(WORK_PREFIX, "") : state?.title;
      break;
    case "grep": case "glob": t = input.pattern ?? state?.title; break;
    case "task": t = input.description ?? state?.title; break;
    case "webfetch": t = input.url ?? state?.title; break;
    default: t = state?.title;
  }
  return clean(t, 120);
}

/** One opencode event -> Activity item, or null for events we do not show. */
export function parseEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const t = Number.isFinite(ev.timestamp) ? ev.timestamp : null;
  const part = ev.part && typeof ev.part === "object" ? ev.part : {};
  const base = { t, kind: null, tool: null, target: null, text: null, status: null, tokens: null };
  switch (ev.type) {
    case "tool_use": {
      const tool = clean(part.tool, 40) || "tool";
      return { ...base, kind: "tool", tool, target: toolTarget(part.tool, part.state),
        status: clean(part.state?.status, 20) || null };
    }
    case "text": {
      const text = clean(part.text, 200);
      return text ? { ...base, kind: "text", text } : null;
    }
    case "step_finish": {
      const tk = part.tokens ?? {};
      return { ...base, kind: "step", tokens: { in: Number(tk.input) || 0, out: Number(tk.output) || 0 } };
    }
    case "error": {
      const text = clean(ev.error?.data?.message ?? ev.error?.message ?? ev.error?.name, 200);
      return { ...base, kind: "error", text: text || "error" };
    }
    default: return null;
  }
}

export function parseLines(text) {
  const items = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const it = parseEvent(ev);
    if (it) items.push(it);
  }
  return items;
}

/** Follows one slot's events file by byte offset. */
export class ActivityTail {
  constructor(logDir, slot) {
    this.logDir = logDir;
    this.slot = slot;
    this.path = null;
    this.offset = 0;
    this.items = [];
  }

  /**
   * Call once a second with slot.turn?.events. Returns {slot, items, reset} when something
   * should be sent, else null. A null/invalid path keeps the last items on screen.
   */
  poll(eventsPath) {
    const safe = safeEventsPath(this.logDir, eventsPath);
    if (!safe) return null;
    let reset = false;
    if (safe !== this.path) {
      this.path = safe;
      this.offset = 0;
      this.items = [];
      reset = true;
    }
    let st;
    try {
      st = fs.lstatSync(safe);
      if (!st.isFile()) return reset ? this.#emit(true, []) : null;
      // Parent directories may not be symlinks that leave the log dir.
      const real = fs.realpathSync(safe);
      const rel = path.relative(fs.realpathSync(this.logDir), real);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return reset ? this.#emit(true, []) : null;
    } catch {
      return reset ? this.#emit(true, []) : null; // file not there yet
    }

    let start = this.offset;
    let dropFirst = false;
    if (reset || st.size < this.offset) {
      // first sight of this path (or it was truncated): only the last 256 KB
      if (!reset) { reset = true; this.items = []; }
      start = Math.max(0, st.size - FIRST_TAIL_BYTES);
      dropFirst = start > 0;
    }
    if (st.size === start) return reset ? this.#emit(true, []) : null;
    const want = Math.min(st.size - start, MAX_READ);
    const buf = Buffer.alloc(want);
    let fd;
    try {
      fd = fs.openSync(safe, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let got = 0;
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, start + got);
        if (n === 0) break;
        got += n;
      }
    } catch {
      return reset ? this.#emit(true, []) : null;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }

    let text = buf;
    let base = start;
    if (dropFirst) {
      const nl = text.indexOf(10);
      if (nl < 0) { this.offset = start + want; return reset ? this.#emit(true, []) : null; }
      text = text.subarray(nl + 1);
      base += nl + 1;
    }
    const lastNl = text.lastIndexOf(10);
    if (lastNl < 0) {
      // a partial line: wait for the rest, unless it is absurdly long
      this.offset = want >= MAX_READ ? base + text.length : base;
      return reset ? this.#emit(true, []) : null;
    }
    this.offset = base + lastNl + 1;
    const fresh = parseLines(text.subarray(0, lastNl + 1).toString("utf8"));
    this.items = [...this.items, ...fresh].slice(-MAX_ITEMS);
    if (reset) return this.#emit(true, this.items);
    return fresh.length ? this.#emit(false, fresh.slice(-MAX_ITEMS)) : null;
  }

  #emit(reset, items) {
    return { slot: this.slot, items, reset };
  }
}
