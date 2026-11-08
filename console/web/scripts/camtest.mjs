// Camera checks against the simulator. Needs `simulate.mjs --dir .sim` running and `vite --port 5173`.
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) fails++; };
const vbOf = (p) => p.evaluate(() => document.querySelector("svg.machine").getAttribute("viewBox").split(" ").map(Number));
const mid = (v) => [v[0] + v[2] / 2, v[1] + v[3] / 2];

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { if (!sessionStorage.getItem("seen")) { sessionStorage.setItem("seen", "1"); localStorage.removeItem("hc-cam"); } });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(BASE);
await sleep(9000); // let the lanes reach build

const v0 = await vbOf(p);
// --- wheel zoom toward the cursor keeps the point under the cursor
const target = { x: 900, y: 300 };
const under = (v, rect) => { const s = Math.min(rect.width / v[2], rect.height / v[3]); return [mid(v)[0] + (target.x - (rect.left + rect.width / 2)) / s, mid(v)[1] + (target.y - (rect.top + rect.height / 2)) / s]; };
const rect = await p.evaluate(() => { const r = document.querySelector("svg.machine").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
const a0 = under(v0, rect);
await p.mouse.move(target.x, target.y);
for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, -240); await sleep(30); }
await sleep(1200);
const v1 = await vbOf(p);
const a1 = under(v1, rect);
ok(v1[2] < v0[2] * 0.4, `wheel zooms in smoothly (viewBox width ${v0[2].toFixed(0)} -> ${v1[2].toFixed(0)})`);
ok(Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) < 6, `point under the cursor stays put (drift ${Math.hypot(a1[0] - a0[0], a1[1] - a0[1]).toFixed(2)} units)`);
await p.screenshot({ path: "screenshots/cam-zoom-cursor.png" });

// --- drag pans
await p.mouse.move(900, 250);
await p.mouse.down();
await p.mouse.move(760, 200, { steps: 8 });
await p.mouse.up();
const v2 = await vbOf(p);
ok(Math.abs(mid(v2)[0] - mid(v1)[0]) > 10, `drag pans (centre moved ${(mid(v2)[0] - mid(v1)[0]).toFixed(1)}, ${(mid(v2)[1] - mid(v1)[1]).toFixed(1)})`);

// --- keys
await p.keyboard.press("0");
await sleep(1500);
const vf = await vbOf(p);
ok(Math.abs(vf[2] - v0[2]) < 1, "0 fits");
await p.keyboard.press("+");
await sleep(900);
const vp1 = await vbOf(p);
ok(vp1[2] < vf[2] * 0.8, "+ zooms in");
await p.keyboard.press("-");
await p.keyboard.press("-");
await sleep(900);
const vm = await vbOf(p);
ok(vm[2] > vf[2], "- zooms out below fit (min 0.5x)");
await p.keyboard.press("0");
await sleep(900);
await p.keyboard.press("ArrowLeft");
await sleep(900);
const va = await vbOf(p);
ok(mid(va)[0] < mid(vf)[0] - 5, "arrow keys pan");
await p.keyboard.press("0");
await sleep(1200);

// --- double-click a station: fly there, readout flashes
const st = await p.evaluate(() => {
  const s = document.querySelector("svg.machine"); const m = s.getScreenCTM();
  const pt = s.createSVGPoint(); pt.x = (15.5 - 14) * 0.8660254 * 10; pt.y = (15.5 + 14) * 5 - 10; // build station of lane 2 (belt centre y = 14)
  const q = pt.matrixTransform(m); return { x: q.x, y: q.y };
});
await p.mouse.dblclick(st.x, st.y);
await sleep(300);
const mid1 = await vbOf(p);
await sleep(1400);
const vfly = await vbOf(p);
ok(vfly[2] < vf[2] * 0.4, `double-click flies to the station (width ${vf[2].toFixed(0)} -> ${vfly[2].toFixed(0)})`);
ok(Math.abs(mid1[2] - vfly[2]) > 1, "the flight is animated, not a jump");
ok(await p.$eval("article.lane[data-lane='2']", (e) => e.classList.contains("flash")), "lane 2 readout is highlighted");
await p.screenshot({ path: "screenshots/cam-flyto-station.png" });

// --- follow: critically damped, no jitter
await p.keyboard.press("0");
await sleep(1000);
await p.keyboard.press("f");
const samples = await p.evaluate(() => new Promise((res) => {
  const out = []; const t0 = performance.now();
  const el = document.querySelector("svg.machine");
  const tick = () => { const v = el.getAttribute("viewBox").split(" ").map(Number); out.push([performance.now() - t0, v[0] + v[2] / 2, v[1] + v[3] / 2, v[2]]); if (performance.now() - t0 < 6000) requestAnimationFrame(tick); else res(out); };
  requestAnimationFrame(tick);
}));
let maxStep = 0, reversals = 0, lastSign = 0;
for (let i = 1; i < samples.length; i++) {
  const dx = samples[i][1] - samples[i - 1][1];
  maxStep = Math.max(maxStep, Math.abs(dx));
  const sg = Math.sign(dx) * (Math.abs(dx) > 0.02 ? 1 : 0);
  if (sg && lastSign && sg !== lastSign) reversals++;
  if (sg) lastSign = sg;
}
const zEnd = samples.at(-1)[3];
console.log(`follow: ${samples.length} frames in 6 s, max centre step ${maxStep.toFixed(2)} units/frame, x-direction reversals ${reversals}, final width ${zEnd.toFixed(0)}`);
ok(zEnd < vf[2] * 0.5, "follow zooms to the active station");
ok(reversals <= 4, "follow does not jitter (few direction reversals)");
await p.screenshot({ path: "screenshots/cam-follow.png" });
// manual drag pauses follow
await p.mouse.move(900, 250); await p.mouse.down(); await p.mouse.move(820, 250, { steps: 4 }); await p.mouse.up();
ok(await p.evaluate(() => window.__hc.cam.follow === false), "a manual drag pauses follow");

// --- 4x close-up of the press mid-strike
await p.evaluate(() => { const [x, y, z] = [15.5, 4, 3.6]; window.__hc.flyTo((x - y) * 8.660254, (x + y) * 5 - z * 10, 4); });
await sleep(1600);
for (let i = 0; i < 12; i++) { await p.screenshot({ path: `screenshots/.closeup-${i}.png`, clip: { x: 0, y: 62, width: 1060, height: 790 } }); await sleep(90); }

// --- cinematic
await p.keyboard.press("0");
await p.evaluate(() => window.__hc.setFollow(true, 0));
await sleep(2500);
await p.keyboard.press("h");
await sleep(900);
ok(await p.evaluate(() => !document.querySelector("header.pulse") && !document.querySelector("footer.recent")), "H hides the pulse strip and Recent");
await p.screenshot({ path: "screenshots/cinematic.png" });
await p.keyboard.press("h");
await sleep(400);
ok(await p.evaluate(() => !!document.querySelector("header.pulse")), "H again restores the chrome");

// --- persistence
await p.keyboard.press("0");
await p.evaluate(() => window.__hc.flyTo(60, 120, 2.2));
await sleep(1500);
const vs = await vbOf(p);
await sleep(600);
await p.reload();
await sleep(1500);
const vr = await vbOf(p);
ok(Math.abs(vr[2] - vs[2]) < 2 && Math.abs(vr[0] - vs[0]) < 2, `camera is restored after reload (${vs[2].toFixed(0)} vs ${vr[2].toFixed(0)})`);
await ctx.close();

// --- reduced motion: instant jumps
const rctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
await rctx.addInitScript(() => localStorage.removeItem("hc-cam"));
const rp = await rctx.newPage();
rp.on("pageerror", (e) => errors.push("rm: " + e.message));
await rp.goto(BASE);
await sleep(2500);
const r0 = await vbOf(rp);
await rp.keyboard.press("+");
await sleep(80);
const r1 = await vbOf(rp);
ok(r1[2] < r0[2] * 0.8, `reduced motion: zoom is an instant jump (${r0[2].toFixed(0)} -> ${r1[2].toFixed(0)} within 80 ms)`);
await rctx.close();

// --- phone: two-finger gestures pan/zoom (CDP touch emulation), one finger keeps swiping lanes
const mctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await mctx.addInitScript(() => localStorage.removeItem("hc-cam"));
const mp = await mctx.newPage();
mp.on("pageerror", (e) => errors.push("mobile: " + e.message));
await mp.goto(BASE);
await sleep(2500);
const m0 = await mp.evaluate(() => document.querySelector("svg.machine").getAttribute("viewBox").split(" ").map(Number));
const cdp = await mctx.newCDPSession(mp);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((q, i) => ({ x: q[0], y: q[1], id: i })) });
const box = await mp.evaluate(() => { const r = document.querySelector("svg.machine").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await touch("touchStart", [[box[0] - 40, box[1]], [box[0] + 40, box[1]]]);
for (let i = 1; i <= 8; i++) await touch("touchMove", [[box[0] - 40 - i * 8, box[1]], [box[0] + 40 + i * 8, box[1]]]);
await touch("touchEnd", []);
await sleep(300);
const m1 = await mp.evaluate(() => document.querySelector("svg.machine").getAttribute("viewBox").split(" ").map(Number));
ok(m1[2] < m0[2] * 0.85, `phone: two-finger pinch zooms (${m0[2].toFixed(0)} -> ${m1[2].toFixed(0)})`);
await mp.screenshot({ path: "screenshots/mobile-pinch.png" });
await mctx.close();

await b.close();
ok(errors.length === 0, `zero page errors${errors.length ? ": " + errors[0] : ""}`);
console.log(fails ? `${fails} FAILED` : "all camera checks passed");
process.exit(fails ? 1 : 0);
