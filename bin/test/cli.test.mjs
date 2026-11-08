// The CLI's contract: exit codes, stdout vs stderr, --json shapes, and that status reads the
// same fixture files the console is tested against (contracts/fixtures).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "bin", "factory.mjs");
const FIX = path.join(ROOT, "contracts", "fixtures");
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

function stateDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "factory-cli-"));
  fs.cpSync(path.join(FIX, "ui"), path.join(d, "ui"), { recursive: true });
  fs.cpSync(path.join(FIX, "ctl"), path.join(d, "ctl"), { recursive: true });
  return d;
}

test("help goes to stdout and exits 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /factory demo/);
  assert.match(run("help", "status").stdout, /--watch/);
  assert.match(run("status", "--help").stdout, /--dir DIR/);
});

test("an unknown command or flag is a usage error (2) on stderr, with a suggestion", () => {
  const r = run("stat");
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /did you mean: factory status/);
  assert.equal(run("status", "--nope").status, 2);
});

test("status renders every lane from the fixture files", () => {
  const d = stateDir();
  const r = run("status", "--dir", d);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lanes busy/);
  assert.match(r.stdout, /#26 /);
  assert.match(r.stdout, /PR #140/);
  assert.match(r.stdout, /queue #37/);
  assert.doesNotMatch(r.stdout, /\x1b\[/, "NO_COLOR means no escape codes");
});

test("status --json is the raw slot objects plus control and halt", () => {
  const d = stateDir();
  const j = JSON.parse(run("status", "--dir", d, "--json").stdout);
  assert.equal(j.v, 1);
  assert.deepEqual(j.slots.map((s) => s.slot), [1, 2, 3]);
  assert.equal(j.control.agents, 2);
});

test("status shows a halt", () => {
  const d = stateDir();
  fs.copyFileSync(path.join(FIX, "ui", "halt.example.json"), path.join(d, "ui", "halt.json"));
  const r = run("status", "--dir", d);
  assert.match(r.stdout, /HALTED/);
  assert.match(r.stdout, /halt: /);
});

test("status without state is 'not configured' (3) and says what to run", () => {
  const r = run("status", "--dir", path.join(os.tmpdir(), "factory-does-not-exist"));
  assert.equal(r.status, 3);
  assert.match(r.stderr, /factory status --demo/);
});

test("doctor --json reports both tiers and every check has a fix when it fails", () => {
  const r = run("doctor", "--json");
  const j = JSON.parse(r.stdout);
  assert.equal(j.v, 1);
  assert.equal(j.demo_ready, true, "this test runs on Node, so the demo tier passes");
  assert.equal(r.status, j.lanes_ready ? 0 : 1);
  for (const c of j.checks) assert.ok(c.ok || (typeof c.fix === "string" && c.fix.length > 0), c.id);
});
