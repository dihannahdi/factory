// Single-user authentication: scrypt password hash, HMAC-signed stateless session cookie,
// and a GLOBAL failure limiter (CF-Connecting-IP is forgeable at the origin, so no per-IP state).
import crypto from "node:crypto";
import { readJsonSafe } from "./files.mjs";

export const SESSION_TTL_S = 7 * 24 * 3600;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_N = 1 << 16; // 64 MB of scrypt memory at r=8; the unit has MemoryMax=256M
const MAXMEM = 128 * 1024 * 1024;

const scryptAsync = (pw, salt, keylen, opts) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))));

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest();

export function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

export async function hashPassword(password, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = params;
  const key = await scryptAsync(password, salt, keylen, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function parseHash(stored) {
  if (typeof stored !== "string" || stored.length > 512) return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(N) || N < 1024 || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  if (salt.length < 8 || hash.length < 16 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}

const DUMMY = { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: Buffer.alloc(16, 7), hash: Buffer.alloc(64) };

/** Always burns one scrypt, so an unknown account or malformed hash takes as long as a wrong password. */
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  const h = parsed ?? DUMMY;
  const key = await scryptAsync(String(password), h.salt, h.hash.length,
    { N: h.N, r: h.r, p: h.p, maxmem: MAXMEM });
  const ok = crypto.timingSafeEqual(key, h.hash);
  return parsed !== null && ok;
}

/** auth.json is re-read on every login. Returns {email, hash} or null. */
export function loadAuth(file) {
  const r = readJsonSafe(file, 4096);
  if (!r.ok || !r.value || typeof r.value.email !== "string" || typeof r.value.hash !== "string") return null;
  return { email: r.value.email, hash: r.value.hash };
}

/** Email is compared case-insensitively and in constant time; the scrypt always runs. */
export async function checkCredentials(auth, email, password) {
  const emailOk = auth ? safeEqual(String(email).trim().toLowerCase(), auth.email.trim().toLowerCase()) : false;
  const passOk = await verifyPassword(password, auth?.hash);
  return emailOk && passOk;
}

// ------------------------------------------------------------------ session cookie
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const mac = (secret, payload) => crypto.createHmac("sha256", secret).update(payload).digest();

export function signCookie(secret, nowS, ttl = SESSION_TTL_S) {
  const exp = nowS + ttl;
  const nonce = b64u(crypto.randomBytes(16));
  const payload = `${exp}.${nonce}`;
  return { value: `${payload}.${b64u(mac(secret, payload))}`, exp, nonce };
}

/** -> {exp, nonce} or null. Tamper, malformed and expired values are all just null. */
export function verifyCookie(secret, value, nowS) {
  if (typeof value !== "string" || value.length > 200) return null;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return null;
  const expected = mac(secret, `${m[1]}.${m[2]}`);
  const given = Buffer.from(m[3], "base64url");
  if (b64u(given) !== m[3] || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const exp = Number(m[1]);
  if (!(exp > nowS)) return null;
  return { exp, nonce: m[2] };
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// ------------------------------------------------------------------ global failure limiter
export class LoginLimiter {
  constructor({ max = 5, windowMs = 15 * 60e3, lockMs = 15 * 60e3 } = {}) {
    Object.assign(this, { max, windowMs, lockMs });
    this.failures = [];
    this.lockedUntil = 0;
  }
  /** -> 0 when a login may proceed, else seconds to wait. */
  retryAfter(nowMs) {
    return nowMs < this.lockedUntil ? Math.ceil((this.lockedUntil - nowMs) / 1000) : 0;
  }
  fail(nowMs) {
    this.failures = this.failures.filter((t) => nowMs - t < this.windowMs);
    this.failures.push(nowMs);
    if (this.failures.length >= this.max) {
      this.lockedUntil = nowMs + this.lockMs;
      this.failures = [];
    }
  }
}

/** Logged-out sessions stay revoked until they would have expired anyway (in memory only). */
export class Revoked {
  constructor() { this.map = new Map(); }
  add(nonce, exp) { this.map.set(nonce, exp); }
  has(nonce, nowS) {
    for (const [k, e] of this.map) if (e <= nowS) this.map.delete(k);
    return this.map.has(nonce);
  }
}
