// GET /api/slots/:k/inspect (SCHEMA section 6.1). Everything is read from the slot's log_dir, which
// must resolve inside HC_LOG_DIR. Turn files are parsed with the same section 5.2 rules as the
// live activity feed (lib/activity.mjs) and cached by (path, size, mtime) so a drawer that polls
// every 2 s only re-parses the file that is growing.
import fs from "node:fs";
import path from "node:path";
import { parseEvent, safeEventsPath } from "./activity.mjs";
import { readJsonSafe } from "./files.mjs";

export const MAX_TURN_ITEMS = 2000;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TURN_FILES = 200;
export const MAX_TOUCHED = 500;
const CACHE_MAX = 300;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const WORK_PREFIX = /^\/home\/factory\/(?:s[1-3]\/)?work\//;
const TURN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.jsonl$/;
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Resolved real path of `dir` when it is a non-symlink directory inside `root`, else null. */
export function resolveDirInside(root, dir) {
  try {
    const lexical = safeEventsPath(root, dir);
    if (!lexical) return null;
    const st = fs.lstatSync(lexical);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    const real = fs.realpathSync(lexical);
    const rel = path.relative(fs.realpathSync(root), real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return real;
  } catch { return null; }
}

/** Last `max` bytes of a regular, non-symlink file, cut to whole lines. Null when unreadable. */
export function readWholeLines(file, max = MAX_FILE_BYTES) {
  let fd;
  try {
    const l = fs.lstatSync(file);
    if (l.isSymbolicLink() || !l.isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const want = Math.min(st.size, max);
    const start = st.size - want;
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = fs.readSync(fd, buf, got, want - got, start + got);
      if (n === 0) break;
      got += n;
    }
    let b = buf.subarray(0, got);
    if (start > 0) { const nl = b.indexOf(10); b = nl < 0 ? b.subarray(0, 0) : b.subarray(nl + 1); }
    const last = b.lastIndexOf(10);
    b = last < 0 ? b.subarray(0, 0) : b.subarray(0, last + 1); // a partial last line is still being written
    return { text: b.toString("utf8"), stat: st };
  } catch { return null; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

const cache = new Map(); // file -> {sig, value}
function cacheSet(file, sig, value) {
  cache.delete(file);
  cache.set(file, { sig, value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
export function clearCache() { cache.clear(); }
export function cacheSize() { return cache.size; }

/** One turn file -> {items, touches, first, last}. Items are exactly the live activity items. */
export function loadTurnFile(file) {
  let st;
  try {
    st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
  } catch { return null; }
  const sig = `${st.size}:${st.mtimeMs}:${st.ino}`;
  const hit = cache.get(file);
  if (hit && hit.sig === sig) return hit.value;
  const r = readWholeLines(file);
  if (!r) return null;
  const items = [];
  const touches = [];
  let first = null, last = null;
  for (const line of r.text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const it = parseEvent(ev);
    if (!it) continue;
    items.push(it);
    if (it.t !== null) { if (first === null || it.t < first) first = it.t; if (last === null || it.t > last) last = it.t; }
    if (it.kind === "tool" && (it.tool === "read" || it.tool === "edit" || it.tool === "write") && it.status !== "error") {
      const fp = ev.part?.state?.input?.filePath;
      if (typeof fp === "string" && fp) {
        touches.push({ path: fp.replace(WORK_PREFIX, "").replace(CTRL, " ").trim().slice(0, 300), edit: it.tool !== "read", t: it.t });
      }
    }
  }
  const value = { items, touches, first, last, mtimeMs: st.mtimeMs };
  cacheSet(file, sig, value);
  return value;
}

export const phaseOf = (name) => name.replace(/\.jsonl$/, "").replace(/-\d+$/, "");

/** Every turn file of a run dir, in time order: [{phase, file, full, first, last, data}]. */
export function listTurns(realDir) {
  let names;
  try { names = fs.readdirSync(realDir); } catch { return []; }
  const out = [];
  for (const name of names.filter((n) => TURN_NAME.test(n)).sort().slice(0, MAX_TURN_FILES)) {
    const full = path.join(realDir, name);
    const data = loadTurnFile(full);
    if (data) out.push({ phase: phaseOf(name), file: name, full, first: data.first, last: data.last, data });
  }
  const key = (t) => t.first ?? t.data.mtimeMs;
  return out.sort((a, b) => key(a) - key(b) || (a.file < b.file ? -1 : 1));
}

export function readJsonFile(file, kind, max = 1 << 20) {
  const r = readJsonSafe(file, max);
  if (!r.ok) return null;
  const isArr = Array.isArray(r.value);
  if (kind === "array") return isArr ? r.value : null;
  return r.value && typeof r.value === "object" && !isArr ? r.value : null;
}

export function aggregateFiles(turns) {
  const m = new Map();
  for (const t of turns) for (const x of t.data.touches) {
    if (!x.path) continue;
    let e = m.get(x.path);
    if (!e) { e = { path: x.path, edits: 0, reads: 0, last: 0 }; m.set(x.path, e); }
    if (x.edit) e.edits++; else e.reads++;
    if (x.t !== null && x.t > e.last) e.last = x.t;
  }
  return [...m.values()].sort((a, b) => b.last - a.last || (a.path < b.path ? -1 : 1)).slice(0, MAX_TOUCHED);
}

/** The section 6.1 body for one slot object, or null when it has no usable log_dir. */
export function inspectSlot(logRoot, slot) {
  if (!slot?.log_dir) return null;
  const dir = resolveDirInside(logRoot, slot.log_dir);
  if (!dir) return null;
  const turns = listTurns(dir);

  let turn = null;
  if (slot.turn && typeof slot.turn.events === "string") {
    const safe = safeEventsPath(logRoot, slot.turn.events);
    const realDir = safe ? resolveDirInside(logRoot, path.dirname(safe)) : null;
    const data = realDir ? loadTurnFile(path.join(realDir, path.basename(safe))) : null;
    turn = { phase: slot.turn.phase ?? null, started: slot.turn.started ?? null, items: data ? data.items.slice(-MAX_TURN_ITEMS) : [] };
  }
  return {
    slot: slot.slot, run_id: slot.run_id ?? null, stage: slot.stage ?? null, issue: slot.issue ?? null,
    pr: slot.pr ?? null, ci: slot.ci ?? null, turn,
    turns: turns.map((t) => ({ phase: t.phase, file: t.file, first: t.first, last: t.last, items: t.data.items.length })),
    files: aggregateFiles(turns),
    checklist: readJsonFile(path.join(dir, "checklist.json"), "array"),
    plan: readJsonFile(path.join(dir, "plan.json"), "object"),
  };
}
