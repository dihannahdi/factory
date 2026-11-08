// Screenshot run. Needs: `node console/dev/simulate.mjs --dir .sim --speed 6` and `npx vite --port 5173`.
//   node scripts/shots.mjs [baseUrl]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const BASE = process.argv[2] ?? "http://localhost:5173";
const OUT = path.resolve("screenshots");
const SIM = path.resolve("../../.sim");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (p, name, opts = {}) => p.screenshot({ path: path.join(OUT, name), ...opts });

const browser = await chromium.launch();
const ctx = async (opts = {}, theme = "dark") => {
  const c = await browser.newContext({ deviceScaleFactor: 1, ...opts });
  await c.addInitScript((t) => localStorage.setItem("hc-theme", t), theme);
  return c;
};
const post = (p, body) => p.evaluate(async (b) => (await fetch("/api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).status, body);
const state = (p) => p.evaluate(async () => (await fetch("/api/state")).json());

// ------------------------------------------------------------ simulator (fresh, so there are issues left to pick)
import { spawn } from "node:child_process";
const SPEED = process.argv[3] ?? "3";
fs.rmSync(SIM, { recursive: true, force: true });
fs.mkdirSync(path.join(SIM, "ctl"), { recursive: true });
fs.writeFileSync(path.join(SIM, "ctl", "control.json"), JSON.stringify({ v: 1, agents: 1, models: ["opencode/deepseek-v4.1-flash-free", "opencode/space-bunny-free"], model_mode: "ordered", paused: false, queue: [], skip: [76], resume_ack: null }));
const sim = spawn(process.execPath, [path.resolve("../dev/simulate.mjs"), "--dir", SIM, "--speed", SPEED], { stdio: "ignore" });
process.on("exit", () => sim.kill());
for (let i = 0; i < 40 && !fs.existsSync(path.join(SIM, "ui", "slots", "3.json")); i++) await sleep(250);

// ------------------------------------------------------------ desktop, staged: lane 1 deploying, lane 2 in ci, lane 3 building
const desk = await ctx({ viewport: { width: 1440, height: 900 } });
const p = await desk.newPage();
p.on("pageerror", (e) => console.log("pageerror", e.message));
await p.goto(BASE);
await post(p, { agents: 1, paused: false });
const T0 = Date.now();
let got = null, a2 = false, a3 = false;
for (let i = 0; i < 900; i++) {
  const el = (Date.now() - T0) / 1000;
  if (!a2 && el > 8) { await post(p, { agents: 2 }); a2 = true; }
  if (!a3 && el > 40) { await post(p, { agents: 3 }); a3 = true; }
  const s = await state(p);
  const st = s.slots.map((x) => x.stage);
  if (st.includes("deploy") && st.includes("ci") && st.includes("build")) { got = s; break; }
  await sleep(150);
}
console.log(got ? "staged: deploy + ci + build" : "WARN: could not stage deploy+ci+build together");
// regions to diff, from the live element boxes
const parts = await p.evaluate(() => [...document.querySelectorAll("[data-part]")].map((e) => { const r = e.getBoundingClientRect(); return { part: e.getAttribute("data-part"), x: r.x, y: r.y, w: r.width, h: r.height }; }));
// 8 frames, 400 ms apart
const t0 = Date.now();
const frames = [];
for (let i = 0; i < 8; i++) {
  const wait = t0 + i * 400 - Date.now();
  if (wait > 0) await sleep(wait);
  const name = `anim-${String(i + 1).padStart(2, "0")}.png`;
  await shot(p, name);
  frames.push(name);
}
const stages = (await state(p)).slots.map((s) => s.stage);
console.log("stages after sequence", stages);
fs.writeFileSync(path.join(OUT, ".frozen.json"), JSON.stringify(got ?? (await state(p))));

// motion proof: changed pixels between consecutive frames, inside the figure only
const read = (n) => PNG.sync.read(fs.readFileSync(path.join(OUT, n)));
const diff = (a, b, clip) => {
  let n = 0;
  for (let y = clip.y; y < clip.y + clip.h; y++) for (let x = clip.x; x < clip.x + clip.w; x++) {
    const i = (y * a.width + x) * 4;
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
  }
  return n;
};
const FIG = { x: 0, y: 70, w: 1060, h: 770 };
const imgs = frames.map(read);
console.log("figure pixels changed between anim frames:", imgs.slice(1).map((im, i) => diff(imgs[i], im, FIG)).join(" "));

const region = (pt) => ({ x: Math.max(0, Math.floor(pt.x - 12)), y: Math.max(0, Math.floor(pt.y - 12)), w: Math.ceil(pt.w + 24), h: Math.ceil(pt.h + 24) });
console.log("changed pixels per object, summed over 7 frame pairs (and frames that differ):");
for (const pt of parts) {
  const r = region(pt);
  const d = imgs.slice(1).map((im, i) => diff(imgs[i], im, r));
  console.log(`  ${pt.part.padEnd(10)} ${String(d.reduce((a, b) => a + b, 0)).padStart(6)}  (${d.filter((x) => x > 0).length}/7)`);
}
fs.writeFileSync(path.join(OUT, ".parts.json"), JSON.stringify(parts));

// desktop hero + others
await sleep(300);
await shot(p, "desktop-dark.png");
await p.evaluate(() => document.querySelector('button[aria-label^="Theme"]').click());
await sleep(400);
await shot(p, "desktop-blueprint.png");
await p.evaluate(() => document.querySelector('button[aria-label^="Theme"]').click());
// 4x close-up of a press mid-strike (waits for a lane in build whose ram is down)
let struck = false;
for (let i = 0; i < 400 && !struck; i++) {
  const k = await p.evaluate(() => window.__hc && window.__hcAnim ? window.__hcAnim.lanes.findIndex((l, j) => l.press > 0.8 && document.querySelectorAll("article.lane")[j]?.textContent.includes("build")) : -1);
  if (k >= 0) {
    await p.evaluate((k) => { const [x, y, z] = [15.5, 4 + 10 * k, 3.6]; window.__hc.flyTo((x - y) * 8.660254, (x + y) * 5 - z * 10, 4); }, k);
    await sleep(1700);
    for (let t = 0; t < 120 && !struck; t++) {
      const down = await p.evaluate((k) => window.__hcAnim.lanes[k].press > 0.85, k);
      if (down) { await shot(p, "closeup-press-4x.png"); struck = true; }
      else await sleep(25);
    }
  } else await sleep(100);
}
console.log("close-up of a strike captured:", struck);
// cinematic: follow the working lane, hide the chrome
await p.keyboard.press("0");
await p.evaluate(() => { const i = window.__hcAnim.lanes.findIndex((l) => l.o > 0.5); window.__hc.setFollow(true, Math.max(0, i)); });
await sleep(3500);
await p.keyboard.press("h");
await sleep(900);
await shot(p, "cinematic.png");
await p.keyboard.press("h");
await p.keyboard.press("0");
await sleep(1500);
await p.click('button[aria-label="Open issue board"]');
await sleep(700);
await shot(p, "board-drawer.png");
await p.keyboard.press("Escape");
await sleep(300);
await p.click('button[aria-label="Stop lane 1"] >> nth=0').catch(() => {});
await sleep(400);
await shot(p, "sheet-stop.png");
await p.keyboard.press("Escape");
await p.click('button[aria-label="Steer lane 2 agent"]').catch(() => {});
await sleep(400);
await p.fill("textarea", "Use the shared retry helper, not a hand-rolled loop.").catch(() => {});
await shot(p, "sheet-steer.png");
await p.keyboard.press("Escape");
await sleep(200);

// halted
fs.writeFileSync(path.join(SIM, "ui", "halt.json"), JSON.stringify({ id: `${Math.floor(Date.now() / 1000)}-deploy`, reason: "deploy 1a2b3c4 failed (failure)", at: Math.floor(Date.now() / 1000), issue_url: "https://github.com/acme/shop/issues/150" }));
await sleep(3500);
await shot(p, "halted.png");
fs.rmSync(path.join(SIM, "ui", "halt.json"), { force: true });
await sleep(1500);
await desk.close();

// ------------------------------------------------------------ reduced motion: frozen data, two frames 1 s apart
const frozen = fs.readFileSync(path.join(OUT, ".frozen.json"), "utf8");
const rm = await ctx({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const rp = await rm.newPage();
await rp.route("**/api/state", (r) => r.fulfill({ status: 200, contentType: "application/json", body: frozen }));
await rp.route("**/api/stream", (r) => r.abort());
await rp.goto(BASE);
await sleep(2500);
await shot(rp, "rm-01.png");
await sleep(1000);
await shot(rp, "rm-02.png");
const a = read("rm-01.png"), b = read("rm-02.png");
console.log("reduced-motion figure pixels changed:", diff(a, b, FIG), "| whole page:", diff(a, b, { x: 0, y: 0, w: a.width, h: a.height }));
await rm.close();

// ------------------------------------------------------------ mobile
const mob = await ctx({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mp = await mob.newPage();
await mp.goto(BASE);
await sleep(2500);
await shot(mp, "mobile-lane1.png");
await mp.click('button:has-text("controls")');
await sleep(500);
await shot(mp, "mobile-sheet.png");
await mp.keyboard.press("Escape");
await mp.evaluate(() => document.querySelector(".swiper")?.scrollTo({ left: document.querySelector(".swiper").clientWidth, behavior: "instant" }));
await sleep(800);
await shot(mp, "mobile-lane2.png");
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log("mobile horizontal page overflow px:", overflow);
await mob.close();

// ------------------------------------------------------------ login -> dashboard against the simulator
const fl = await ctx({ viewport: { width: 1440, height: 900 } });
const fp = await fl.newPage();
let authed = false;
fp.on("pageerror", (e) => console.log("flow pageerror", e.message));
await fp.route("**/api/state", (r) => (authed ? r.continue() : r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"auth"}' })));
await fp.route("**/api/stream", (r) => (authed ? r.continue() : r.abort()));
await fp.route("**/api/login", (r) => { authed = true; r.fulfill({ status: 204 }); });
await fp.goto(BASE);
await sleep(1000);
await fp.fill('input[type="email"]', "owner@example.com");
await fp.fill('input[type="password"]', "correct horse battery");
await shot(fp, "login-flow-1-login.png");
await fp.click('button[type="submit"]');
await fp.waitForSelector("header.pulse", { timeout: 8000 });
await sleep(2500);
console.log("login -> dashboard switched without reload:", await fp.evaluate(() => !!document.querySelector("header.pulse") && !document.querySelector("form[aria-label="Sign in"]")));
await shot(fp, "login-flow-2-dashboard.png");
await fl.close();

// ------------------------------------------------------------ login (401 everywhere)
const lg = await ctx({ viewport: { width: 1440, height: 900 } });
const lp = await lg.newPage();
await lp.route("**/api/state", (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"auth"}' }));
await lp.goto(BASE);
await sleep(1200);
await shot(lp, "login.png");
await lg.close();

await browser.close();
console.log("done");
sim.kill();
process.exit(0);
