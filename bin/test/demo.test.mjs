// `factory demo` end to end, the way a first-time user meets it: it starts, the printed link logs
// the browser in, `status --demo` reads it, and a demo that dies without Ctrl-C neither fools
// `status --demo` nor leaves its directory behind once the next demo starts.
// Needs the built console (console/public); CI builds it before this runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "bin", "factory.mjs");
const built = fs.existsSync(path.join(ROOT, "console", "public", "index.html"));

// Every process in this test sees its own temp dir, so a demo the developer is running is untouched.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "factory-demo-test-"));
const env = { ...process.env, NO_COLOR: "1", TMPDIR: TMP, TMP, TEMP: TMP };
const pointer = () => JSON.parse(fs.readFileSync(path.join(TMP, "factory-demo-last"), "utf8"));
const status = () => spawnSync(process.execPath, [CLI, "status", "--demo"], { encoding: "utf8", env });

function startDemo(port) {
  const child = spawn(process.execPath, [CLI, "demo", "--no-open", "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error(`demo did not print its link:\n${buf}`)), 20000);
    child.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/open\s+(http:\/\/127\.0\.0\.1:\d+\/login\/\S+)/);
      if (m) { clearTimeout(t); resolve({ child, url: m[1] }); }
    });
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`demo exited early (${code}):\n${buf}`)); });
  });
}
const gone = (child) => new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));

test("demo: link logs in, status reads it, a killed demo is noticed and cleaned up", { skip: !built && "console/public is not built (cd console/web && npm ci && npm run build)" }, async (t) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const a = await startDemo(port);
  t.after(() => a.child.kill("SIGKILL"));

  const login = await fetch(a.url, { redirect: "manual" });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const origin = new URL(a.url).origin;
  const st = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
  assert.equal(st.status, 200);
  assert.equal((await st.json()).slots.length, 3);
  assert.equal((await fetch(`${origin}/api/state`)).status, 401, "no cookie, no state");

  const s1 = status();
  assert.equal(s1.status, 0, s1.stderr);
  assert.match(s1.stdout, /lanes busy/);

  const firstDir = pointer().dir;
  assert.ok(fs.existsSync(firstDir));
  a.child.kill("SIGKILL"); // no Ctrl-C: the demo's own cleanup never runs
  await gone(a.child);
  // Its simulator and console go with it: the console stops answering.
  let up = true;
  for (let i = 0; i < 40 && up; i++) {
    up = await fetch(`${origin}/api/health`).then(() => true, () => false);
    if (up) await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(up, false, "the console outlived a killed demo (orphaned child)");
  const s2 = status();
  assert.equal(s2.status, 3, "a dead demo is 'not running', not stale data");
  assert.match(s2.stderr, /factory demo/);

  const b = await startDemo(port + 1);
  t.after(() => b.child.kill("SIGKILL"));
  assert.equal(fs.existsSync(firstDir), false, "the next demo removed the dead one's directory");
  assert.notEqual(pointer().dir, firstDir);
  b.child.kill("SIGKILL");
  await gone(b.child);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });
