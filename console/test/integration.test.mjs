import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE = path.resolve(HERE, "..");
const EMAIL = "Tester@Example.com";
const PASSWORD = "a sufficiently long passphrase";

const children = [];
const kill = () => { for (const c of children) try { c.kill(); } catch { /* ignore */ } };
process.on("exit", kill);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

let root, port, origin, base, cookie, serverLog = "";
const sseEvents = [];
let sseReq;

function req(method, p, { headers = {}, body, json = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const h = { ...headers };
    if (payload !== undefined) h["Content-Length"] = Buffer.byteLength(payload);
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        if (json && text) try { parsed = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    r.on("error", reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}
const authed = (extra = {}) => ({ Cookie: cookie, ...extra });
const post = (p, body, headers = {}) => req("POST", p, { body, headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, ...headers } });
const get = (p) => req("GET", p, { headers: { Cookie: cookie } });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-int-"));
  const etc = path.join(root, "etc");
  const pub = path.join(root, "public");
  fs.mkdirSync(path.join(pub, "assets"), { recursive: true });
  fs.writeFileSync(path.join(pub, "index.html"), "<!doctype html><title>x</title>");
  fs.writeFileSync(path.join(pub, "assets", "app-abc123.js"), "console.log(1)");

  const pw = spawnSync(process.execPath, [path.join(CONSOLE, "bin", "passwd.mjs")], {
    input: `${EMAIL}\n${PASSWORD}\n`, env: { ...process.env, HC_ETC_DIR: etc }, encoding: "utf8",
  });
  assert.equal(pw.status, 0, pw.stderr);
  assert.ok(!pw.stdout.includes(PASSWORD));

  const sim = spawn(process.execPath, [path.join(CONSOLE, "dev", "simulate.mjs"), "--dir", path.join(root, "sim"), "--speed", "8"], { stdio: "ignore" });
  children.push(sim);
  await until(() => fs.existsSync(path.join(root, "sim", "ui", "slots", "3.json")), 10000, "simulator files");

  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, [path.join(CONSOLE, "server.mjs")], {
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port), HC_INSECURE_COOKIE: "1", HC_ORIGIN: origin,
      HC_UI_DIR: path.join(root, "sim", "ui"), HC_CTL_DIR: path.join(root, "sim", "ctl"), HC_LOG_DIR: path.join(root, "sim", "log"),
      HC_PUBLIC_DIR: pub, HC_ETC_DIR: etc, HC_LOGIN_TOKEN: LOGIN_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(srv);
  srv.stdout.on("data", (d) => { serverLog += d; });
  srv.stderr.on("data", (d) => { serverLog += d; });
  await until(async () => { try { return (await req("GET", "/api/health")).status === 200; } catch { return false; } }, 10000, "server health");
});

after(() => { try { sseReq?.destroy(); } catch { /* ignore */ } kill(); });

test("unauthenticated, origin, content-type", async () => {
  assert.equal((await req("GET", "/api/health")).json.ok, true);
  const s = await req("GET", "/api/state");
  assert.equal(s.status, 401);
  assert.deepEqual(s.json, { error: "auth" });
  assert.equal((await req("GET", "/api/stream")).status, 401);

  const noType = await req("POST", "/api/login", { body: { email: EMAIL, password: PASSWORD }, headers: { Origin: origin } });
  assert.equal(noType.status, 415);
  const textType = await req("POST", "/api/login", { body: "{}", headers: { Origin: origin, "Content-Type": "text/plain" } });
  assert.equal(textType.status, 415);
  const wrongOrigin = await req("POST", "/api/login", { body: { email: EMAIL, password: PASSWORD }, headers: { "Content-Type": "application/json", Origin: "https://evil.example" } });
  assert.equal(wrongOrigin.status, 403);
  assert.deepEqual(wrongOrigin.json, { error: "origin" });
  const noOrigin = await req("POST", "/api/login", { body: { email: EMAIL, password: PASSWORD }, headers: { "Content-Type": "application/json" } });
  assert.equal(noOrigin.status, 403);
  const unauthPost = await req("POST", "/api/control", { body: { agents: 1 }, headers: { "Content-Type": "application/json", Origin: origin } });
  assert.equal(unauthPost.status, 401);
  const tooBig = await req("POST", "/api/login", { body: "x".repeat(20000), headers: { "Content-Type": "application/json", Origin: origin } });
  assert.equal(tooBig.status, 413);
});

test("security headers on api and static; SPA fallback; traversal", async () => {
  const want = ["content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy"];
  for (const p of ["/api/health", "/", "/some/spa/route", "/assets/app-abc123.js", "/api/nope"]) {
    const r = await req("GET", p);
    for (const h of want) assert.ok(r.headers[h], `${h} on ${p}`);
    assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
  }
  assert.equal((await req("GET", "/")).headers["cache-control"], "no-cache");
  assert.match((await req("GET", "/some/spa/route")).text, /<title>x<\/title>/);
  const asset = await req("GET", "/assets/app-abc123.js");
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.match(asset.headers["content-type"], /javascript/);
  assert.equal((await req("GET", "/assets/missing.js")).status, 404);
  assert.equal((await req("GET", "/api/nope")).status, 404);
  for (const p of ["/../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2fetc/passwd", "/..%5c..%5cwindows/win.ini"]) {
    const r = await req("GET", p);
    assert.ok([200, 400, 404].includes(r.status), `${p} -> ${r.status}`);
    if (r.status === 200) assert.match(r.text, /<title>x<\/title>/, `${p} must only ever serve the SPA index`);
    assert.ok(!/root:|\[fonts\]/.test(r.text));
  }
});

const LOGIN_TOKEN = "demo-token-0123456789abcdef";

test("login link (HC_LOGIN_TOKEN): the right token sets a session and redirects home; a wrong one does not", async () => {
  const wrong = await req("GET", "/login/demo-token-0123456789abcdeX");
  assert.equal(wrong.headers["set-cookie"], undefined);
  assert.notEqual(wrong.status, 303);
  const ok = await req("GET", `/login/${LOGIN_TOKEN}`);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, "/");
  const c = ok.headers["set-cookie"][0].split(";")[0];
  const st = await req("GET", "/api/state", { headers: { Cookie: c } });
  assert.equal(st.status, 200);
});

test("login: bad credentials 401, good 204 with cookie", async () => {
  const bad = await req("POST", "/api/login", { body: { email: EMAIL, password: "wrong wrong wrong" }, headers: { "Content-Type": "application/json", Origin: origin } });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.json, { error: "bad_credentials" });
  const ok = await req("POST", "/api/login", { body: { email: EMAIL.toLowerCase(), password: PASSWORD }, headers: { "Content-Type": "application/json", Origin: origin } });
  assert.equal(ok.status, 204);
  const sc = ok.headers["set-cookie"][0];
  assert.match(sc, /^hc=\d+\.[\w-]+\.[\w-]{43}; Max-Age=604800; Path=\/; HttpOnly; SameSite=Strict$/, "insecure dev cookie: no Secure, no __Host-");
  cookie = sc.split(";")[0];
  const st = await get("/api/state");
  assert.equal(st.status, 200);
  assert.equal(st.json.v, 1);
  assert.equal(st.json.slots.length, 3);
  assert.equal(st.json.readonly, false);
  assert.ok(st.json.control && st.json.github && st.json.models && st.json.metrics);
  assert.deepEqual(Object.keys(st.json.activity), ["1", "2", "3"]);
  assert.ok(st.json.recent.length > 0 && st.json.recent.length <= 30);
});

function parseSse(buf) {
  const out = [];
  for (const block of buf.split("\n\n")) {
    if (!block.trim()) continue;
    let event = null, data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (event) out.push({ event, data: JSON.parse(data) });
    else out.push({ comment: block });
  }
  return out;
}

test("stream: snapshot, slot and activity events", async () => {
  let raw = "";
  let head;
  await new Promise((resolve, reject) => {
    sseReq = http.get({ host: "127.0.0.1", port, path: "/api/stream", headers: { Cookie: cookie } }, (res) => {
      head = res;
      res.setEncoding("utf8");
      res.on("data", (c) => {
        raw += c;
        const cut = raw.lastIndexOf("\n\n");
        if (cut >= 0) { sseEvents.push(...parseSse(raw.slice(0, cut + 2))); raw = raw.slice(cut + 2); }
      });
      resolve();
    });
    sseReq.on("error", reject);
  });
  assert.equal(head.statusCode, 200);
  assert.match(head.headers["content-type"], /^text\/event-stream/);
  assert.equal(head.headers["cache-control"], "no-cache, no-transform");
  assert.equal(head.headers["x-accel-buffering"], "no");
  assert.ok(head.headers["content-security-policy"]);

  await until(() => sseEvents.some((e) => e.event === "snapshot"), 5000, "snapshot");
  const first = sseEvents.filter((e) => e.event)[0];
  assert.equal(first.event, "snapshot", "snapshot is the first event");
  assert.equal(first.data.slots.length, 3);
  assert.ok(sseEvents.some((e) => e.comment === ": ok"));

  await until(() => sseEvents.some((e) => e.event === "slot"), 15000, "a slot event");
  const act = await until(() => sseEvents.find((e) => e.event === "activity" && e.data.items.length > 0), 15000, "an activity event");
  assert.ok([1, 2, 3].includes(act.data.slot));
  assert.equal(typeof act.data.reset, "boolean");
  assert.ok(act.data.items.every((i) => ["tool", "text", "step", "error"].includes(i.kind)));
  for (const name of ["control", "github", "metrics"]) assert.ok(first.data[name], `snapshot.${name}`);
});

test("control: validation over HTTP; agents:3 wakes slot 3", async () => {
  const state = (await get("/api/state")).json;
  assert.equal(state.control.agents, 2);
  assert.equal(state.slots[2].state, "parked");

  const paid = await post("/api/control", { models: ["opencode/deepseek-v4.1-flash"] });
  assert.equal(paid.status, 400);
  assert.deepEqual(paid.json, { error: "invalid", field: "models" });
  assert.deepEqual((await post("/api/control", { agents: 9 })).json, { error: "invalid", field: "agents" });
  assert.deepEqual((await post("/api/control", { agents: 3, bogus: 1 })).json, { error: "invalid", field: "bogus" });
  assert.equal((await post("/api/control", "not json")).status, 400);

  const mark = sseEvents.length;
  const ok = await post("/api/control", { agents: 3 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.control.agents, 3);
  assert.equal(ok.json.control.v, 1);
  assert.match(ok.json.control.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "sim", "ctl", "control.json"), "utf8")).agents, 3);

  await until(() => sseEvents.slice(mark).some((e) => e.event === "control" && e.data.agents === 3), 5000, "control event");
  await until(() => sseEvents.slice(mark).some((e) => e.event === "slot" && e.data.slot === 3 && e.data.state !== "parked"), 15000, "slot 3 leaving parked");
});

test("issues: queue, unqueue, skip, unskip, 404", async () => {
  const gh = (await get("/api/state")).json.github;
  const eligible = gh.issues.find((i) => i.class === "eligible");
  assert.ok(eligible, "fixture has an eligible issue");
  const n = eligible.n;
  let r = await post(`/api/issues/${n}`, { action: "queue" });
  assert.equal(r.status, 200);
  assert.ok(r.json.control.queue.some((q) => q.n === n));
  r = await post(`/api/issues/${n}`, { action: "skip" });
  assert.ok(r.json.control.skip.includes(n));
  assert.ok(!r.json.control.queue.some((q) => q.n === n));
  r = await post(`/api/issues/${n}`, { action: "unskip" });
  assert.ok(!r.json.control.skip.includes(n));
  assert.equal((await post(`/api/issues/${n}`, { action: "dance" })).status, 400);
  assert.equal((await post("/api/issues/987654", { action: "queue" })).status, 404);
  assert.equal((await post(`/api/issues/${n}`, { action: "unqueue" })).status, 200);
});

test("inspect and replay: auth, running slot drawer, run list, run replay", async () => {
  for (const p of ["/api/slots/1/inspect", "/api/replay", "/api/replay/issue-1-20260101T000000Z-s1"]) {
    const r = await req("GET", p);
    assert.equal(r.status, 401, p);
    assert.deepEqual(r.json, { error: "auth" });
  }
  assert.equal((await req("POST", "/api/replay", { body: {}, headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie } })).status, 405);

  const st = (await get("/api/state")).json;
  const slot = (await until(async () => {
    const s = (await get("/api/state")).json.slots.find((x) => x.log_dir && x.run_id);
    return s;
  }, 15000, "a running slot")) ?? st.slots[0];
  const k = slot.slot;
  const ins = await until(async () => {
    const r = await get(`/api/slots/${k}/inspect`);
    return r.status === 200 && r.json.checklist && r.json.plan && r.json.turns.length && r.json.files.length ? r : null;
  }, 40000, "inspect with checklist, plan, turns and files");
  const b = ins.json;
  assert.equal(b.slot, k);
  assert.ok(b.issue?.n > 0);
  assert.ok(Array.isArray(b.turns) && b.turns[0].file.endsWith(".jsonl") && b.turns[0].items > 0);
  assert.ok(b.files.every((f) => typeof f.path === "string" && !f.path.startsWith("/home/factory/") && f.edits + f.reads > 0));
  assert.ok(b.plan.requirements.length >= 6 && b.plan.requirements.length <= 10);
  assert.equal(b.checklist.length, b.plan.requirements.length);
  for (const c of b.checklist) assert.equal(typeof c.done, "boolean");
  assert.equal((await get("/api/slots/9/inspect")).status, 404);
  assert.equal((await get("/api/slots/0/inspect")).status, 404);
  assert.equal((await req("POST", `/api/slots/${k}/inspect`, { body: {}, headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie } })).status, 405);

  const list = await get("/api/replay");
  assert.equal(list.status, 200);
  assert.ok(list.json.runs.length >= 1 && list.json.runs.length <= 50);
  const run = list.json.runs.find((r) => r.items > 0) ?? list.json.runs[0];
  assert.match(run.id, /^issue-\d+-\d{8}T\d{6}Z-s[1-3]$/);
  assert.equal(typeof run.title, "string");
  const one = await get(`/api/replay/${run.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.id, run.id);
  assert.ok(one.json.items.length > 0 && one.json.items.every((i) => typeof i.phase === "string" && typeof i.t === "number"));
  assert.ok(one.json.timeline.length >= 1 && one.json.timeline.some((x) => x.stage === "plan"));
  assert.ok(one.json.timeline.every((x, i, a) => i === 0 || a[i - 1].t <= x.t));

  assert.equal((await get("/api/replay/not-an-id")).status, 400);
  assert.equal((await get("/api/replay/..%2f..%2fetc")).status, 400);
  assert.equal((await get("/api/replay/issue-1-20260101T000000Z-s1")).status, 404);
});

test("interrupt: steer is applied or pending; stop with skip; 409 and 400", async () => {
  assert.deepEqual((await post("/api/slots/1/interrupt", { action: "steer", message: "  \u0000  " })).json, { error: "invalid", field: "message" });
  assert.equal((await post("/api/slots/1/interrupt", { action: "fly" })).status, 400);
  assert.equal((await post("/api/slots/7/interrupt", { action: "stop" })).status, 404);

  const live = await until(async () => {
    const s = (await get("/api/state")).json;
    return s.slots.find((x) => x.run_id && x.turn);
  }, 30000, "a slot with a run_id");
  const k = live.slot;
  const mark = sseEvents.length;
  const r = await post(`/api/slots/${k}/interrupt`, { action: "steer", message: "Use the retry helper.\u0007\nNo hand-rolled loop." });
  assert.equal(r.status, 202);
  assert.match(r.json.id, /^[0-9a-f-]{36}$/);
  const file = JSON.parse(fs.readFileSync(path.join(root, "sim", "ctl", `interrupt-${k}.json`), "utf8"));
  assert.equal(file.id, r.json.id);
  assert.equal(file.run_id, live.run_id);
  assert.equal(file.action, "steer");
  assert.equal(file.message, "Use the retry helper.\nNo hand-rolled loop.");
  assert.equal(file.skip, false);
  assert.equal(file.v, 1);

  const ev = await until(() => sseEvents.slice(mark).find((e) => e.event === "slot" && e.data.slot === k
    && (e.data.steer?.last?.outcome === "applied" || e.data.steer?.pending)), 15000, "steer applied or pending");
  assert.ok(ev.data.steer.last?.outcome === "applied" || ev.data.steer.pending);

  // stop + skip: the issue lands in control.skip, the lane stops
  const cur = (await get("/api/state")).json.slots[k - 1];
  if (cur.run_id && cur.issue && !["merge", "deploy"].includes(cur.stage)) {
    const st = await post(`/api/slots/${k}/interrupt`, { action: "stop", skip: true });
    assert.equal(st.status, 202);
    const c = JSON.parse(fs.readFileSync(path.join(root, "sim", "ctl", "control.json"), "utf8"));
    assert.ok(c.skip.includes(cur.issue.n));
    const f2 = JSON.parse(fs.readFileSync(path.join(root, "sim", "ctl", `interrupt-${k}.json`), "utf8"));
    assert.equal(f2.action, "stop"); assert.equal(f2.skip, true); assert.equal(f2.run_id, cur.run_id);
    await until(() => sseEvents.slice(mark).some((e) => e.event === "slot" && e.data.slot === k && ["stopping", "stopped"].includes(e.data.state)), 15000, "stop");
  }
  // a stopped/idle slot has no run_id -> 409
  const idle = await until(async () => (await get("/api/state")).json.slots.find((s) => !s.run_id && s.state !== "parked"), 30000, "an idle slot");
  const nr = await post(`/api/slots/${idle.slot}/interrupt`, { action: "steer", message: "hello" });
  assert.equal(nr.status, 409);
  assert.deepEqual(nr.json, { error: "no_run" });
});

test("logout clears the cookie and revokes it", async () => {
  const keep = cookie;
  const l = await post("/api/logout", undefined);
  assert.equal(l.status, 204);
  assert.match(l.headers["set-cookie"][0], /Max-Age=0/);
  cookie = keep;
  assert.equal((await get("/api/state")).status, 401, "the old cookie no longer works");
});

test("server logged no secrets", () => {
  assert.ok(!serverLog.includes(PASSWORD));
  assert.ok(!serverLog.includes(cookie.split("=")[1]));
});
