// Safe file access. Everything the console reads from /var/lib/factory-ops/ui is written by root,
// everything under ctl/ by us. Neither is trusted blindly: no symlinks, no devices, bounded size,
// and a bad read never replaces the last good value (SCHEMA section 0).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Read a small regular file. Returns {ok, buf} or {ok:false, reason}. */
export function readFileSafe(file, maxBytes = 1 << 20) {
  let fd;
  try {
    const l = fs.lstatSync(file);
    if (l.isSymbolicLink()) return { ok: false, reason: "symlink" };
    if (!l.isFile()) return { ok: false, reason: "not_regular" };
    if (l.size > maxBytes) return { ok: false, reason: "too_big" };
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not_regular" };
    if (st.size > maxBytes) return { ok: false, reason: "too_big" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return { ok: true, buf: buf.subarray(0, off), stat: st };
  } catch (e) {
    return { ok: false, reason: e.code === "ENOENT" ? "missing" : "error" };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

export function readJsonSafe(file, maxBytes = 1 << 20) {
  const r = readFileSafe(file, maxBytes);
  if (!r.ok) return r;
  try {
    return { ok: true, value: JSON.parse(r.buf.toString("utf8")) };
  } catch {
    return { ok: false, reason: "parse" };
  }
}

/** Atomic write: tmp file in the same directory, then rename. Mode is set explicitly (umask-proof). */
export function writeFileAtomic(file, data, mode = 0o660) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    try { fs.fchmodSync(fd, mode); } catch { /* not supported on some platforms */ }
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function writeJsonAtomic(file, value, mode = 0o660) {
  writeFileAtomic(file, JSON.stringify(value, null, 1) + "\n", mode);
}

/**
 * A JSON file polled by (mtime, size, inode) that keeps its last good value.
 * refresh() returns true when `value` changed. A missing file resets to null (its absence is
 * meaningful, e.g. halt.json); an unreadable, garbage or symlinked file keeps the last good one.
 */
export class JsonCache {
  constructor(file, { maxBytes = 1 << 20, validate = null } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.validate = validate;
    this.sig = null;
    this.value = null;
    this.error = null;
  }
  refresh() {
    let st;
    try {
      st = fs.lstatSync(this.file);
    } catch (e) {
      if (e.code === "ENOENT") {
        this.error = null;
        this.sig = null;
        const had = this.value !== null;
        this.value = null;
        return had;
      }
      this.error = "stat";
      return false;
    }
    const sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (sig === this.sig) return false;
    const r = readJsonSafe(this.file, this.maxBytes);
    if (!r.ok || (this.validate && !this.validate(r.value))) {
      this.error = r.ok ? "invalid" : r.reason;
      return false; // keep the last good value; retry on the next poll
    }
    this.sig = sig;
    this.error = null;
    this.value = r.value;
    return true;
  }
}
