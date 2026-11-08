#!/usr/bin/env node
// factory: the command-line front door. Node built-ins only (Node >= 22.12).
//
//   factory demo      the simulator and the real console on 127.0.0.1, no credentials
//   factory doctor    what this machine has, what it is missing, and the command that fixes each gap
//   factory status    the lanes, read from the same ui/ and ctl/ files the console reads
//
// Conventions (clig.dev): data on stdout, messages on stderr; --json on every read command; no
// prompts; NO_COLOR, --no-color and TERM=dumb turn colour off. Exit codes: 0 ok, 1 failure,
// 2 usage, 3 not configured.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONSOLE = path.join(ROOT, "console");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const LAST_DEMO = path.join(os.tmpdir(), "factory-demo-last");

// The running demo: {dir, pid}. A demo killed without Ctrl-C leaves this behind, so a reader checks
// the pid, and the next demo removes a dead one's directory.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function lastDemo() {
  try {
    const v = JSON.parse(fs.readFileSync(LAST_DEMO, "utf8"));
    return v && typeof v.dir === "string" && Number.isInteger(v.pid) ? v : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- output
const argvNoColor = process.argv.includes("--no-color");
const colorOn = (stream) => stream.isTTY && !argvNoColor && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
const paint = (stream) => {
  const on = colorOn(stream);
  const c = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: c(1), dim: c(2), red: c(31), green: c(32), yellow: c(33), blue: c(34), cyan: c(36) };
};
const out = paint(process.stdout);
const err = paint(process.stderr);
const say = (s = "") => process.stderr.write(s + "\n");
const print = (s = "") => process.stdout.write(s + "\n");

class UsageError extends Error {}
class NotConfigured extends Error {}

// ---------------------------------------------------------------- help
const HELP = `factory ${VERSION}: an autonomous coding-agent orchestrator. Orchestrator should be fun.

usage: factory <command> [options]

commands
  demo      run the simulator and the console locally; needs nothing but Node
  doctor    check this machine for what factory needs, with a fix for each gap
  status    show the lanes, their stage, issue and model

options for every command
  -h, --help      help for that command
  --no-color      plain output (NO_COLOR and TERM=dumb also work)

start here
  factory demo

docs: README.md · contracts/SCHEMA.md · docs/roadmap.md`;

const CMD_HELP = {
  demo: `usage: factory demo [--port 4420] [--speed 4] [--no-open] [--keep]

Runs the simulator, which plays the orchestrator's side of the file contract, and the real
console against it on 127.0.0.1. Nothing touches GitHub, a model, or your repos.

  --port N      first port to try (default 4420; the next free one is used if it is taken)
  --speed N     how fast the simulated lanes move (default 4)
  --no-open     do not open the browser
  --keep        keep the demo's state directory after Ctrl-C`,
  doctor: `usage: factory doctor [--json]

Checks what this machine has. The demo needs only Node. Running real lanes needs Linux with
systemd, root, git, gh, jq, flock, curl and opencode. Each missing piece comes with the command
that fixes it. Exits 0 when lanes can run here, 1 when something is missing.`,
  status: `usage: factory status [--dir DIR] [--demo] [--json] [--watch]

Reads ui/slots/*.json, ui/halt.json and ctl/control.json under DIR.

  --dir DIR     the state directory holding ui/ and ctl/ (default: $FACTORY_STATE_DIR,
                else /var/lib/factory-ops)
  --demo        read the demo that is running now (started by \`factory demo\`)
  --json        print the raw lane objects as JSON
  --watch       redraw every 2 seconds (terminal only)`,
};

// ---------------------------------------------------------------- demo
async function freePort(start) {
  for (let p = start; p < start + 20; p++) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
      s.listen(p, "127.0.0.1");
    });
    if (ok) return p;
  }
  throw new Error(`no free port between ${start} and ${start + 19}; pass --port`);
}

function ensureConsoleBuilt() {
  const pub = path.join(CONSOLE, "public", "index.html");
  if (fs.existsSync(pub)) return;
  const web = path.join(CONSOLE, "web");
  if (!fs.existsSync(path.join(web, "package.json"))) throw new Error(`the console is not built and ${web} is missing`);
  say(err.dim("first run: building the console once (npm ci + vite build, about a minute)"));
  for (const args of [...(fs.existsSync(path.join(web, "node_modules")) ? [] : [["ci", "--no-audit", "--no-fund"]]), ["run", "build"]]) {
    const r = process.platform === "win32"
      ? spawnSync(`npm ${args.join(" ")}`, { cwd: web, stdio: ["ignore", "ignore", "inherit"], shell: true })
      : spawnSync("npm", args, { cwd: web, stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`\`npm ${args.join(" ")}\` failed in ${web}; run it there to see why`);
  }
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* the URL is printed anyway */ }
}

async function demo(argv) {
  const { values: o } = parseArgs({ args: argv, options: {
    port: { type: "string", default: "4420" }, speed: { type: "string", default: "4" },
    "no-open": { type: "boolean" }, keep: { type: "boolean" }, "no-color": { type: "boolean" },
  } });
  const startPort = Number(o.port), speed = Number(o.speed);
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) throw new UsageError("--port must be a port number");
  if (!(speed > 0 && speed <= 50)) throw new UsageError("--speed must be a number between 0 and 50");

  ensureConsoleBuilt();
  const { hashPassword } = await import(pathToFileURL(path.join(CONSOLE, "lib", "auth.mjs")).href);

  const prev = lastDemo();
  if (prev && !alive(prev.pid) && path.basename(prev.dir).startsWith("factory-demo-")) {
    try { fs.rmSync(prev.dir, { recursive: true, force: true }); } catch { /* fine */ }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-demo-"));
  for (const d of ["ui", "ctl", "log", "etc"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, "etc", "secret"), crypto.randomBytes(32), { mode: 0o600 });
  // A random password nobody needs: the one-time link below logs the browser in.
  const hash = await hashPassword(crypto.randomBytes(24).toString("base64url"));
  fs.writeFileSync(path.join(dir, "etc", "auth.json"), JSON.stringify({ email: "demo@localhost", hash }) + "\n", { mode: 0o600 });
  const token = crypto.randomBytes(24).toString("base64url");
  const port = await freePort(startPort);
  if (port !== startPort) say(err.dim(`port ${startPort} is taken; using ${port}`));
  fs.writeFileSync(LAST_DEMO, JSON.stringify({ dir, pid: process.pid }));

  const children = [];
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
    try { if (lastDemo()?.dir === dir) fs.rmSync(LAST_DEMO); } catch { /* fine */ }
    if (!o.keep) setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } process.exit(code); }, 300);
    else { say(err.dim(`state kept in ${dir}`)); process.exit(code); }
  };
  process.on("SIGINT", () => { say(); stop(0); });
  process.on("SIGTERM", () => stop(0));

  // Children exit when this process does, however it ends (bin/lib/exit-with-parent.mjs).
  const leash = ["--import", pathToFileURL(path.join(ROOT, "bin", "lib", "exit-with-parent.mjs")).href];
  const sim = spawn(process.execPath, [...leash, path.join(CONSOLE, "dev", "simulate.mjs"), "--dir", dir, "--speed", String(speed)],
    { stdio: ["pipe", "ignore", "pipe"] });
  children.push(sim);
  sim.stderr.on("data", (d) => process.stderr.write(err.dim(`[simulator] ${d}`)));

  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [...leash, path.join(CONSOLE, "server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), HC_ORIGIN: origin, HC_INSECURE_COOKIE: "1",
      HC_UI_DIR: path.join(dir, "ui"), HC_CTL_DIR: path.join(dir, "ctl"), HC_LOG_DIR: path.join(dir, "log"),
      HC_ETC_DIR: path.join(dir, "etc"), HC_PUBLIC_DIR: path.join(CONSOLE, "public"), HC_LOGIN_TOKEN: token,
      HC_READONLY: "0" },
  });
  children.push(server);
  for (const c of children) c.on("exit", (code) => { if (!stopping) { say(err.red(`a demo process exited (code ${code}); stopping`)); stop(1); } });

  const ready = await new Promise((resolve) => {
    let buf = "";
    const t = setTimeout(() => resolve(false), 15000);
    server.stdout.on("data", (d) => { buf += d; if (/listening/.test(buf)) { clearTimeout(t); resolve(true); } });
    server.stderr.on("data", (d) => process.stderr.write(err.dim(`[console] ${d}`)));
  });
  if (!ready) { say(err.red("the console did not start within 15 s")); return stop(1); }

  const url = `${origin}/login/${token}`;
  const open = !o["no-open"] && process.stdout.isTTY;
  say();
  say(`  ${err.bold("factory demo")} ${err.dim("· simulated lanes, nothing touches GitHub or a model")}`);
  say();
  say(`  open    ${err.cyan(url)}${open ? err.dim("  (opening your browser)") : ""}`);
  say(`  watch   ${err.bold("factory status --demo --watch")}  ${err.dim("in another terminal")}`);
  say(`  stop    ${err.bold("Ctrl-C")}`);
  say();
  say(err.dim("  things to try: pause the line, queue an issue from the map, steer a lane, stop one."));
  if (open) openBrowser(url);
  await new Promise(() => {}); // run until Ctrl-C
}

// ---------------------------------------------------------------- doctor
function probe(cmd, args = ["--version"]) {
  const opts = { encoding: "utf8", timeout: 8000 };
  let r = spawnSync(cmd, args, opts);
  // On Windows a tool installed by npm is a .cmd shim, which only a shell can start. One string
  // (not an args array) keeps Node from warning about unescaped shell arguments; the args are ours.
  if (r.error && process.platform === "win32") r = spawnSync([cmd, ...args].join(" "), { ...opts, shell: true });
  if (r.error || r.status !== 0) return null;
  return ((r.stdout || r.stderr || "").trim().split("\n")[0] || "ok").slice(0, 60);
}

function doctor(argv) {
  const { values: o } = parseArgs({ args: argv, options: { json: { type: "boolean" }, "no-color": { type: "boolean" } } });
  const linux = process.platform === "linux";
  const apt = (pkg) => (linux ? `sudo apt-get install -y ${pkg}` : `install ${pkg}`);
  const [maj, min] = process.versions.node.split(".").map(Number);
  const checks = [];
  const add = (group, id, found, fix, need = true) => checks.push({ group, id, ok: !!found, found: found || null, fix: found ? null : fix, required: need });

  add("demo", "node >= 22.12", maj > 22 || (maj === 22 && min >= 12) ? `node ${process.versions.node}` : null,
    "install Node 22.12 or newer: https://nodejs.org");
  add("lanes", "linux", linux ? `${os.type()} ${os.release()}` : null,
    "lanes run on Linux with systemd today; a container runtime for macOS and Windows is on the roadmap");
  add("lanes", "systemd", linux ? probe("systemctl") : null, "lanes need systemd (systemd-run, slices, transient units)");
  add("lanes", "git", probe("git"), apt("git"));
  add("lanes", "jq", probe("jq"), apt("jq"));
  add("lanes", "curl", probe("curl"), apt("curl"));
  add("lanes", "flock", linux ? probe("flock", ["--version"]) : null, apt("util-linux"));
  add("lanes", "gh", probe("gh"), "install the GitHub CLI: https://cli.github.com");
  const ghAuth = checks.at(-1).ok && probe("gh", ["auth", "status"]) !== null;
  add("lanes", "gh logged in", ghAuth ? "yes" : null, "gh auth login  (lanes use a fine-grained token for one repo; see README)");
  add("lanes", "opencode", probe("opencode"), "install opencode: https://opencode.ai/docs");

  const demoReady = checks.filter((c) => c.group === "demo").every((c) => c.ok);
  const lanesReady = checks.every((c) => c.ok);
  if (o.json) { print(JSON.stringify({ v: 1, demo_ready: demoReady, lanes_ready: lanesReady, checks }, null, 1)); return lanesReady ? 0 : 1; }

  const w = Math.max(...checks.map((c) => c.id.length)) + 2;
  print(out.bold("factory doctor"));
  for (const [g, title] of [["demo", "the demo"], ["lanes", "real lanes on a repo"]]) {
    print();
    print(out.dim(title));
    for (const c of checks.filter((x) => x.group === g)) {
      const mark = c.ok ? out.green("✓") : out.red("✗");
      print(`  ${mark} ${c.id.padEnd(w)}${c.ok ? out.dim(c.found) : c.fix}`);
    }
  }
  print();
  const missing = checks.filter((c) => !c.ok).map((c) => c.id);
  if (lanesReady) print(out.green("everything is here. next: read \"Run it on a repo\" in README.md"));
  else if (demoReady) print(`${out.green("the demo works here:")} factory demo\n${out.yellow("real lanes need:")} ${missing.join(", ")}`);
  else print(out.red(`missing: ${missing.join(", ")}`));
  return lanesReady ? 0 : 1;
}

// ---------------------------------------------------------------- status
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const ago = (s) => {
  if (!s) return "";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - s);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 48 * 3600) return `${Math.floor(d / 3600)}h${String(Math.floor((d % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(d / 86400)}d`;
};
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function resolveStateDir(o) {
  if (o.demo) {
    const d = lastDemo();
    if (!d || !alive(d.pid) || !fs.existsSync(d.dir)) throw new NotConfigured("no demo is running. start one with: factory demo");
    return d.dir;
  }
  return o.dir ?? process.env.FACTORY_STATE_DIR ?? "/var/lib/factory-ops";
}

function snapshot(dir) {
  const slotsDir = path.join(dir, "ui", "slots");
  if (!fs.existsSync(slotsDir)) throw new NotConfigured(`no lanes found under ${dir}. try: factory status --demo, or --dir <state dir>`);
  const slots = fs.readdirSync(slotsDir).filter((f) => /^\d+\.json$/.test(f)).map((f) => readJson(path.join(slotsDir, f)))
    .filter(Boolean).sort((a, b) => a.slot - b.slot);
  return { slots, control: readJson(path.join(dir, "ctl", "control.json")), halt: readJson(path.join(dir, "ui", "halt.json")) };
}

function renderStatus(snap) {
  const { slots, control: c, halt } = snap;
  const busy = slots.filter((s) => s.state === "running").length;
  const head = [out.bold("factory"), `${busy}/${slots.length} lanes busy`];
  if (halt) head.push(out.red("HALTED"));
  else if (c?.paused) head.push(out.yellow("paused"));
  if (c?.agents != null) head.push(out.dim(`agents=${c.agents}`));
  const lines = [head.join(out.dim(" · ")), ""];
  const cols = process.stdout.columns || 100;
  const titleW = Math.max(24, Math.min(64, cols - 62));
  lines.push(out.dim(`${"LANE".padEnd(5)}${"STATE".padEnd(9)}${"STAGE".padEnd(9)}${"ISSUE".padEnd(titleW + 1)}${"TIME".padEnd(8)}MODEL`));
  for (const s of slots) {
    const color = s.state === "running" ? out.green : s.state === "backoff" ? out.yellow : out.dim;
    const pr = s.pr ? ` → PR #${s.pr.n}` : "";
    const idle = s.state === "parked" ? "parked: above the agents setting" : s.state === "idle" ? "waiting for an eligible issue" : "";
    const issue = s.issue ? (cut(`#${s.issue.n} ${s.issue.title ?? ""}`, titleW - pr.length) + pr).padEnd(titleW + 1)
      : out.dim(cut(s.note || idle, titleW).padEnd(titleW + 1));
    lines.push(`${String(s.slot).padEnd(5)}${color((s.state ?? "?").padEnd(9))}${(s.stage ?? "").padEnd(9)}${issue}`
      + `${ago(s.issue_started).padEnd(8)}${out.dim((s.model ?? "").replace(/^opencode\//, ""))}`);
  }
  const extra = [];
  if (c?.queue?.length) extra.push(`queue ${c.queue.map((q) => `#${q.n}`).join(" ")}`);
  if (c?.skip?.length) extra.push(`skip ${c.skip.map((n) => `#${n}`).join(" ")}`);
  if (extra.length) lines.push("", out.dim(extra.join("   ")));
  if (halt) lines.push("", out.red(`halt: ${halt.reason}`), out.dim("acknowledge it in the console once the cause is fixed"));
  return lines.join("\n");
}

async function status(argv) {
  const { values: o } = parseArgs({ args: argv, options: {
    dir: { type: "string" }, demo: { type: "boolean" }, json: { type: "boolean" }, watch: { type: "boolean" }, "no-color": { type: "boolean" },
  } });
  const dir = resolveStateDir(o);
  if (o.json) { print(JSON.stringify({ v: 1, ...snapshot(dir) }, null, 1)); return 0; }
  if (!o.watch || !process.stdout.isTTY) { print(renderStatus(snapshot(dir))); return 0; }
  process.on("SIGINT", () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); });
  process.stdout.write("\x1b[?25l");
  for (;;) {
    let text;
    try { text = renderStatus(snapshot(dir)); } catch (e) { text = err.red(e.message); }
    process.stdout.write("\x1b[H\x1b[2J" + text + "\n\n" + out.dim("redrawing every 2 s · Ctrl-C to quit") + "\n");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------------------------------------------------------------- main
const COMMANDS = { demo, doctor, status };

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") { print(rest[0] && CMD_HELP[rest[0]] ? CMD_HELP[rest[0]] : HELP); return 0; }
  if (cmd === "-v" || cmd === "--version" || cmd === "version") { print(VERSION); return 0; }
  const fn = COMMANDS[cmd];
  if (!fn) {
    const near = Object.keys(COMMANDS).find((k) => k.startsWith(cmd.slice(0, 2)));
    throw new UsageError(`unknown command "${cmd}"${near ? `. did you mean: factory ${near}` : ""}. see: factory --help`);
  }
  if (rest.includes("-h") || rest.includes("--help")) { print(CMD_HELP[cmd]); return 0; }
  return (await fn(rest)) ?? 0;
}

main(process.argv.slice(2)).then((code) => { if (code) process.exitCode = code; }, (e) => {
  if (e instanceof UsageError || e?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || e?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
    || e?.code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") { say(err.red(`factory: ${e.message}`)); process.exitCode = 2; return; }
  if (e instanceof NotConfigured) { say(err.yellow(`factory: ${e.message}`)); process.exitCode = 3; return; }
  say(err.red(`factory: ${e.message}`));
  process.exitCode = 1;
});
