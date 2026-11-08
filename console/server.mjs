#!/usr/bin/env node
// factory console backend. Node built-ins only. See contracts/SCHEMA.md sections 1-5.
//
// It reads /var/lib/factory-ops/ui (written by root), writes only /var/lib/factory-ops/ctl, and talks
// HTTP on a loopback port behind Apache + Cloudflare.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SESSION_TTL_S, LoginLimiter, Revoked, checkCredentials, loadAuth, parseCookies, safeEqual, signCookie, verifyCookie,
} from "./lib/auth.mjs";
import { readFileSafe, writeJsonAtomic } from "./lib/files.mjs";
import { State } from "./lib/state.mjs";
import { localZone } from "./lib/metrics.mjs";
import { SseHub } from "./lib/sse.mjs";
import { inspectSlot } from "./lib/inspect.mjs";
import { ID_RE, listRuns, getRun } from "./lib/replay.mjs";
import {
  ControlStore, applyIssueAction, normalizeControl, sanitizeMessage, validatePatch, isoNow,
} from "./lib/control.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 16 * 1024;
const MAX_LOGINS_IN_FLIGHT = 4; // bounds scrypt memory (16 MB each) under a burst

export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
};

class HttpError extends Error {
  constructor(status, body, headers) { super(body?.error ?? String(status)); this.status = status; this.body = body; this.headers = headers; }
}

export function isLoopback(host) {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function loadConfig(env = process.env) {
  const cfg = {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 4420),
    uiDir: env.HC_UI_DIR || "/var/lib/factory-ops/ui",
    ctlDir: env.HC_CTL_DIR || "/var/lib/factory-ops/ctl",
    logDir: env.HC_LOG_DIR || "/var/log/factory",
    publicDir: env.HC_PUBLIC_DIR || path.join(HERE, "public"),
    etcDir: env.HC_ETC_DIR || "/etc/factory-console",
    origin: env.HC_ORIGIN || "https://factory.example.com",
    readonly: env.HC_READONLY === "1",
    insecureCookie: env.HC_INSECURE_COOKIE === "1",
    // HC_LOGIN_TOKEN (loopback only; `factory demo` sets it): GET /login/<token> starts a session
    // without a password, so a local demo opens straight into the console.
    loginToken: env.HC_LOGIN_TOKEN || null,
    // HC_TZ: IANA zone (e.g. "America/New_York") whose midnight resets tokens_today; default this server's zone.
    tz: env.HC_TZ || localZone(),
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error("PORT is not a valid port");
  if (cfg.insecureCookie && !isLoopback(cfg.host)) {
    throw new Error("HC_INSECURE_COOKIE=1 is only allowed when HOST is a loopback address");
  }
  if (cfg.loginToken && !isLoopback(cfg.host)) throw new Error("HC_LOGIN_TOKEN is only allowed when HOST is a loopback address");
  if (cfg.loginToken && cfg.loginToken.length < 24) throw new Error("HC_LOGIN_TOKEN must be at least 24 characters");
  try { new Intl.DateTimeFormat("en-US", { timeZone: cfg.tz }); } catch { throw new Error(`HC_TZ is not a valid IANA time zone: ${cfg.tz}`); }
  return cfg;
}

export function createApp(cfg) {
  const secretRead = readFileSafe(path.join(cfg.etcDir, "secret"), 4096);
  if (!secretRead.ok || secretRead.buf.length < 32) {
    throw new Error(`cannot read a 32+ byte secret at ${path.join(cfg.etcDir, "secret")} (${secretRead.reason ?? "too short"}); run bin/passwd.mjs`);
  }
  const secret = secretRead.buf;
  const authFile = path.join(cfg.etcDir, "auth.json");
  const cookieName = cfg.insecureCookie ? "hc" : "__Host-hc";

  const state = new State({ uiDir: cfg.uiDir, ctlDir: cfg.ctlDir, logDir: cfg.logDir, readonly: cfg.readonly, tz: cfg.tz });
  const store = new ControlStore(cfg.ctlDir);
  const limiter = new LoginLimiter();
  const revoked = new Revoked();
  const hub = new SseHub();
  let loginsInFlight = 0;

  state.on("event", (name, data) => hub.broadcast(name, data));

  // ------------------------------------------------------------ helpers
  const nowS = () => Math.floor(Date.now() / 1000);

  function send(res, status, body, extra = {}) {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
      "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text), ...extra,
    });
    res.end(text);
  }

  function cookieHeader(value, maxAge) {
    const attrs = [`${cookieName}=${value}`, `Max-Age=${maxAge}`, "Path=/", "HttpOnly", "SameSite=Strict"];
    if (!cfg.insecureCookie) attrs.splice(3, 0, "Secure");
    return attrs.join("; ");
  }

  function session(req) {
    const v = parseCookies(req.headers.cookie)[cookieName];
    if (!v) return null;
    const s = verifyCookie(secret, v, nowS());
    if (!s || revoked.has(s.nonce, nowS())) return null;
    return s;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const len = Number(req.headers["content-length"]);
      if (Number.isFinite(len) && len > BODY_LIMIT) return reject(new HttpError(413, { error: "too_large" }));
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > BODY_LIMIT) { reject(new HttpError(413, { error: "too_large" })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function jsonBody(req, { required = true } = {}) {
    const text = await readBody(req);
    if (!text.trim()) {
      if (required) throw new HttpError(400, { error: "invalid", field: "body" });
      return {};
    }
    let v;
    try { v = JSON.parse(text); } catch { throw new HttpError(400, { error: "invalid", field: "body" }); }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, { error: "invalid", field: "body" });
    return v;
  }

  function controlResponse(res, control) { send(res, 200, { control }); }

  // ------------------------------------------------------------ API handlers
  const api = {
    health: (req, res) => send(res, 200, { ok: true }),

    async login(req, res) {
      const body = await jsonBody(req);
      const { email, password } = body;
      if (typeof email !== "string" || typeof password !== "string" || email.length > 254 || password.length > 1024 || !email || !password) {
        throw new HttpError(400, { error: "invalid" });
      }
      const wait = limiter.retryAfter(Date.now());
      if (wait > 0) throw new HttpError(429, { error: "rate_limited", retry_after: wait }, { "Retry-After": String(wait) });
      if (loginsInFlight >= MAX_LOGINS_IN_FLIGHT) {
        throw new HttpError(429, { error: "rate_limited", retry_after: 1 }, { "Retry-After": "1" });
      }
      loginsInFlight++;
      let ok;
      try { ok = await checkCredentials(loadAuth(authFile), email, password); } finally { loginsInFlight--; }
      if (!ok) {
        limiter.fail(Date.now());
        throw new HttpError(401, { error: "bad_credentials" });
      }
      const s = signCookie(secret, nowS(), SESSION_TTL_S);
      res.writeHead(204, { "Set-Cookie": cookieHeader(s.value, SESSION_TTL_S), "Cache-Control": "no-store" });
      res.end();
    },

    async logout(req, res, sess) {
      await readBody(req); // drain, ignore
      revoked.add(sess.nonce, sess.exp);
      res.writeHead(204, { "Set-Cookie": cookieHeader("", 0), "Cache-Control": "no-store" });
      res.end();
    },

    state(req, res) { send(res, 200, state.snapshot()); },

    stream(req, res, sess) {
      if (hub.full()) throw new HttpError(503, { error: "too_many_streams" });
      hub.add(req, res, state.snapshot(), sess.exp * 1000);
    },

    async control(req, res) {
      const patch = await jsonBody(req);
      const out = await store.lock(() => {
        const v = validatePatch(patch, { freeIds: state.freeModelIds(), haltId: state.data.halt?.id ?? null });
        if (!v.ok) throw new HttpError(400, { error: "invalid", field: v.field });
        return store.write({ ...store.read(), ...v.changes });
      });
      state.poll();
      controlResponse(res, out);
    },

    async issue(req, res, sess, m) {
      const n = Number(m[1]);
      const body = await jsonBody(req);
      const action = body.action;
      if (!["queue", "unqueue", "skip", "unskip"].includes(action)) throw new HttpError(400, { error: "invalid", field: "action" });
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, { error: "invalid", field: "n" });
      state.poll();
      if ((action === "queue" || action === "skip") && !(state.data.github?.issues ?? []).some((i) => i.n === n)) {
        throw new HttpError(404, { error: "not_found" });
      }
      const out = await store.lock(() => {
        const r = applyIssueAction(store.read(), action, n, { consumed: state.data.consumed });
        if (!r.ok) throw new HttpError(400, { error: "invalid", field: r.field });
        return store.write(r.control);
      });
      state.poll();
      controlResponse(res, out);
    },

    inspect(req, res, sess, m) {
      const k = Number(m[1]);
      if (!(k >= 1 && k <= 3)) throw new HttpError(404, { error: "not_found" });
      const body = inspectSlot(cfg.logDir, state.data.slots[k - 1]);
      if (!body) throw new HttpError(404, { error: "no_run" });
      send(res, 200, body);
    },

    replayList(req, res) { send(res, 200, listRuns(cfg.logDir, path.join(cfg.uiDir, "stats.jsonl"))); },

    replayRun(req, res, sess, m) {
      const id = m[1];
      if (!ID_RE.test(id)) throw new HttpError(400, { error: "invalid", field: "id" });
      const body = getRun(cfg.logDir, path.join(cfg.uiDir, "stats.jsonl"), id);
      if (!body) throw new HttpError(404, { error: "not_found" });
      send(res, 200, body);
    },

    async interrupt(req, res, sess, m) {
      const k = Number(m[1]);
      if (!(k >= 1 && k <= 3)) throw new HttpError(404, { error: "not_found" });
      const body = await jsonBody(req);
      const action = body.action;
      if (action !== "stop" && action !== "steer") throw new HttpError(400, { error: "invalid", field: "action" });
      if ("skip" in body && typeof body.skip !== "boolean") throw new HttpError(400, { error: "invalid", field: "skip" });
      let message = "";
      if (action === "steer") {
        message = sanitizeMessage(body.message);
        if (!message) throw new HttpError(400, { error: "invalid", field: "message" });
      }
      const skip = action === "stop" && body.skip === true;

      const id = await store.lock(() => {
        state.poll();
        const slot = state.data.slots[k - 1];
        if (!slot.run_id) throw new HttpError(409, { error: "no_run" });
        if (skip && Number.isInteger(slot.issue?.n)) {
          const r = applyIssueAction(store.read(), "skip", slot.issue.n);
          if (!r.ok) throw new HttpError(400, { error: "invalid", field: r.field });
          store.write(r.control); // skipped before the stop is requested, so root cannot re-pick it
        }
        const uuid = crypto.randomUUID();
        writeJsonAtomic(path.join(cfg.ctlDir, `interrupt-${k}.json`),
          { v: 1, id: uuid, run_id: slot.run_id, action, skip, message, at: isoNow() }, 0o660);
        return uuid;
      });
      state.poll();
      send(res, 202, { id });
    },
  };

  const routes = [
    { re: /^\/api\/health$/, method: "GET", public: true, h: api.health },
    { re: /^\/api\/login$/, method: "POST", public: true, h: api.login, mutating: false },
    { re: /^\/api\/logout$/, method: "POST", h: api.logout, mutating: false },
    { re: /^\/api\/state$/, method: "GET", h: api.state },
    { re: /^\/api\/stream$/, method: "GET", h: api.stream },
    { re: /^\/api\/control$/, method: "POST", h: api.control },
    { re: /^\/api\/issues\/(\d{1,9})$/, method: "POST", h: api.issue },
    { re: /^\/api\/slots\/(\d{1,3})\/interrupt$/, method: "POST", h: api.interrupt },
    { re: /^\/api\/slots\/(\d{1,3})\/inspect$/, method: "GET", h: api.inspect },
    { re: /^\/api\/replay$/, method: "GET", h: api.replayList },
    { re: /^\/api\/replay\/([^/]{1,200})$/, method: "GET", h: api.replayRun },
  ];

  async function handleApi(req, res, pathname) {
    const route = routes.find((r) => r.re.test(pathname));
    if (!route) throw new HttpError(404, { error: "not_found" });
    if (req.method !== route.method) throw new HttpError(405, { error: "method" }, { Allow: route.method });
    if (req.method !== "GET") {
      if (req.headers.origin !== cfg.origin) throw new HttpError(403, { error: "origin" });
      if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, { error: "content_type" });
    }
    let sess = null;
    if (!route.public) {
      sess = session(req);
      if (!sess) throw new HttpError(401, { error: "auth" });
    }
    if (cfg.readonly && req.method !== "GET" && route.mutating !== false) throw new HttpError(403, { error: "readonly" });
    return route.h(req, res, sess, route.re.exec(pathname));
  }

  // ------------------------------------------------------------ static files
  function serveFile(req, res, file, st, cache) {
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream", "Content-Length": st.size, "Cache-Control": cache,
    });
    if (req.method === "HEAD") return res.end();
    const stream = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  function statRegular(file) {
    try {
      const st = fs.lstatSync(file);
      return st.isFile() ? st : null;
    } catch { return null; }
  }

  function handleStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, { error: "method" }, { Allow: "GET, HEAD" });
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, { error: "bad_path" }); }
    if (rel.includes("\0") || rel.includes("\\")) throw new HttpError(404, { error: "not_found" });
    const segs = rel.split("/").filter(Boolean);
    if (segs.some((s) => s === ".." || s === ".")) throw new HttpError(404, { error: "not_found" });
    const root = path.resolve(cfg.publicDir);
    const index = path.join(root, "index.html");
    const indexCache = "no-cache";

    if (segs.length) {
      const file = path.join(root, ...segs);
      const st = statRegular(file);
      if (st && file !== index) {
        const cache = segs[0] === "assets" ? "public, max-age=31536000, immutable" : "public, max-age=3600";
        return serveFile(req, res, file, st, cache);
      }
      if (st) return serveFile(req, res, file, st, indexCache);
      if (segs[0] === "assets" || path.extname(segs[segs.length - 1])) throw new HttpError(404, { error: "not_found" });
    }
    const st = statRegular(index); // SPA fallback
    if (!st) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end("console UI is not installed\n");
    }
    serveFile(req, res, index, st, indexCache);
  }

  // ------------------------------------------------------------ server
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      if (typeof req.url !== "string" || !req.url.startsWith("/")) throw new HttpError(400, { error: "bad_request" });
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (cfg.loginToken && req.method === "GET" && pathname.startsWith("/login/") && safeEqual(pathname.slice(7), cfg.loginToken)) {
        const s = signCookie(secret, nowS(), SESSION_TTL_S);
        res.writeHead(303, { Location: "/", "Set-Cookie": cookieHeader(s.value, SESSION_TTL_S), "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) await handleApi(req, res, pathname);
      else handleStatic(req, res, pathname);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpError) {
        send(res, e.status, e.body, { ...(e.status === 413 ? { Connection: "close" } : {}), ...e.headers });
      } else {
        console.error("request failed:", e?.code ?? e?.name ?? "error"); // never the body, never the message
        send(res, 500, { error: "internal" });
      }
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;

  return {
    server, state, hub,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(cfg.port, cfg.host, () => { state.start(); resolve(server.address()); });
      });
    },
    close() {
      state.stop();
      hub.closeAll();
      return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    },
  };
}

// ------------------------------------------------------------------ main
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const cfg = loadConfig();
    const app = createApp(cfg);
    const addr = await app.listen();
    console.log(`factory-console listening on ${addr.address}:${addr.port} readonly=${cfg.readonly ? 1 : 0} origin=${cfg.origin}`);
    const stop = () => app.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (e) {
    console.error(`factory-console: ${e.message}`);
    process.exit(1);
  }
}
