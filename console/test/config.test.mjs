import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { loadConfig, createApp } from "../server.mjs";
import { hashPassword } from "../lib/auth.mjs";

test("config: HC_INSECURE_COOKIE refuses a non-loopback HOST", () => {
  assert.throws(() => loadConfig({ HOST: "0.0.0.0", HC_INSECURE_COOKIE: "1" }), /loopback/);
  assert.throws(() => loadConfig({ HOST: "10.0.0.5", HC_INSECURE_COOKIE: "1" }), /loopback/);
  assert.equal(loadConfig({ HOST: "127.0.0.1", HC_INSECURE_COOKIE: "1" }).insecureCookie, true);
  assert.equal(loadConfig({ HOST: "0.0.0.0" }).insecureCookie, false);
  const d = loadConfig({});
  assert.deepEqual([d.host, d.port, d.origin, d.readonly], ["127.0.0.1", 4420, "https://factory.example.com", false]);
});

test("config: HC_LOGIN_TOKEN is loopback-only and long", () => {
  const t = "x".repeat(24);
  assert.throws(() => loadConfig({ HOST: "0.0.0.0", HC_LOGIN_TOKEN: t }), /loopback/);
  assert.throws(() => loadConfig({ HC_LOGIN_TOKEN: "short" }), /24/);
  assert.equal(loadConfig({ HC_LOGIN_TOKEN: t }).loginToken, t);
  assert.equal(loadConfig({}).loginToken, null);
});

test("config: HC_TZ is an IANA zone, defaulting to the server's own", () => {
  assert.equal(loadConfig({ HC_TZ: "America/New_York" }).tz, "America/New_York");
  assert.equal(loadConfig({}).tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.throws(() => loadConfig({ HC_TZ: "Mars/Olympus" }), /HC_TZ/);
});

test("readonly: every POST except login and logout is 403; snapshot says so", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-ro-"));
  const etc = path.join(root, "etc");
  for (const d of ["etc", "ui/slots", "ctl", "log"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(etc, "secret"), crypto.randomBytes(32));
  fs.writeFileSync(path.join(etc, "auth.json"), JSON.stringify({ email: "a@b.co", hash: await hashPassword("twelve chars!!") }));
  const app = createApp(loadConfig({
    HOST: "127.0.0.1", PORT: "0", HC_INSECURE_COOKIE: "1", HC_READONLY: "1", HC_ORIGIN: "http://x.test",
    HC_UI_DIR: path.join(root, "ui"), HC_CTL_DIR: path.join(root, "ctl"), HC_LOG_DIR: path.join(root, "log"),
    HC_ETC_DIR: etc, HC_PUBLIC_DIR: path.join(root, "none"),
  }));
  const { port } = await app.listen();
  const call = (method, p, body, cookie) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json", Origin: "http://x.test" } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) } }, (res) => {
      let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
    });
    r.on("error", reject); r.end(payload);
  });
  try {
    const login = await call("POST", "/api/login", { email: "a@b.co", password: "twelve chars!!" });
    assert.equal(login.status, 204);
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const st = JSON.parse((await call("GET", "/api/state", null, cookie)).text);
    assert.equal(st.readonly, true);
    assert.deepEqual(st.slots.map((s) => [s.slot, s.state]), [[1, "parked"], [2, "parked"], [3, "parked"]], "missing files -> 3 parked slots");
    assert.equal(st.halt, null);
    for (const [p, b] of [["/api/control", { agents: 2 }], ["/api/issues/5", { action: "skip" }], ["/api/slots/1/interrupt", { action: "stop" }]]) {
      const r = await call("POST", p, b, cookie);
      assert.equal(r.status, 403, p);
      assert.deepEqual(JSON.parse(r.text), { error: "readonly" });
    }
    assert.equal(fs.readdirSync(path.join(root, "ctl")).length, 0, "nothing written in ctl/");
    assert.equal((await call("POST", "/api/logout", null, cookie)).status, 204);
    const bad = await call("POST", "/api/login", { email: "a@b.co", password: "wrong wrong wrong" });
    assert.equal(bad.status, 401);
    for (let i = 0; i < 4; i++) await call("POST", "/api/login", { email: "a@b.co", password: "wrong wrong wrong" });
    const locked = await call("POST", "/api/login", { email: "a@b.co", password: "twelve chars!!" });
    assert.equal(locked.status, 429, "6th attempt is locked even with the right password");
    const body = JSON.parse(locked.text);
    assert.equal(body.error, "rate_limited");
    assert.ok(body.retry_after > 800 && body.retry_after <= 900);
  } finally {
    await app.close();
  }
});
