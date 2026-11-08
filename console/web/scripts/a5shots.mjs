import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:5185";
const OUT = path.resolve("screenshots");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await chromium.launch();
const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await c.addInitScript(() => { try { localStorage.removeItem("hc-cam"); localStorage.removeItem("hc-sound"); } catch {} });
const p = await c.newPage();
p.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
p.on("console", (m) => { if (m.type() === "error") console.log("console.error", m.text()); });
await p.goto(BASE);
await p.waitForSelector("svg.machine");
await sleep(2500);

// ---- sound: no context before a gesture, one after the toggle, no error
const pre = await p.evaluate(() => window.__hcSound.hasContext());
await p.click('button[aria-label="Sound (M)"]');
await sleep(300);
const post = await p.evaluate(() => ({ ctx: window.__hcSound.hasContext(), on: window.__hcSound.isOn() }));
await p.evaluate(() => window.__hcSound.play("thunk"));
await p.keyboard.press("m");
await sleep(200);
const off = await p.evaluate(() => window.__hcSound.isOn());
console.log("SOUND", JSON.stringify({ pre, post, offAfterM: off }));

// ---- tour in cinematic mode
await p.keyboard.press("h");
await p.keyboard.press("t");
const cams = [];
for (let i = 1; i <= 6; i++) {
  await sleep(1000);
  cams.push(await p.evaluate(() => ({ ...window.__hc.snapshotCamera(), lane: window.__hc.cam.followLane, follow: window.__hc.cam.follow })));
  await p.screenshot({ path: path.join(OUT, `tour-0${i}.png`) });
}
console.log("TOUR", JSON.stringify(cams));
// manual zoom pauses the tour
await p.mouse.move(700, 450);
await p.mouse.wheel(0, -300);
await sleep(800);
const afterWheel = await p.evaluate(() => ({ ...window.__hc.snapshotCamera(), follow: window.__hc.cam.follow, tour: window.__hc.cam.tour }));
await sleep(2500);
const stillPaused = await p.evaluate(() => ({ follow: window.__hc.cam.follow, tour: window.__hc.cam.tour }));
console.log("PAUSE", JSON.stringify({ afterWheel, stillPaused }));
await p.keyboard.press("t");
await p.keyboard.press("h");
await p.keyboard.press("0");
await sleep(600);

// ---- replay
await p.keyboard.press("r");
await sleep(800);
await p.screenshot({ path: path.join(OUT, "replay-picker.png") });
const rows = await p.$$eval(".picker .row", (els) => els.map((e) => e.textContent.trim().slice(0, 80)));
console.log("ROWS", rows.length, JSON.stringify(rows.slice(0, 3)));
// pick the run with the most items
const best = await p.evaluate(async () => {
  const r = await (await fetch("/api/replay")).json();
  return [...r.runs].sort((a, b) => b.items - a.items)[0];
});
console.log("BEST", JSON.stringify(best));
const idx = rows.length ? await p.$$eval(".picker .row", (els, tag) => els.findIndex((e) => e.textContent.includes(tag)), best.tag ?? `#${best.issue}`) : 0;
await (await p.$$(".picker .row"))[Math.max(0, idx)].click();
for (let i = 1; i <= 4; i++) {
  await sleep(220);
  await p.screenshot({ path: path.join(OUT, `replay-30x-0${i}.png`) });
  console.log("REPLAY30", i, await p.evaluate(() => document.querySelector(".bar .info")?.textContent));
}
await p.click('.speeds button:has-text("1×")');
await p.click('button[aria-label^="Play"], button[aria-label^="Pause"]').catch(() => {});
await p.evaluate(() => { document.querySelector(".scrub")?.focus(); });
await p.keyboard.press("Home").catch(() => {});
for (let i = 1; i <= 3; i++) { await sleep(1000); await p.screenshot({ path: path.join(OUT, `replay-1x-0${i}.png`) }); console.log("REPLAY1", i, await p.evaluate(() => document.querySelector(".bar .info")?.textContent)); }
const live = await p.evaluate(async () => (await fetch("/api/state")).json());
// held: the live slot for the replayed lane must differ from what the page shows
const shown = await p.evaluate(() => document.querySelector(".badge")?.textContent);
console.log("BADGE", shown);
await p.keyboard.press("Escape");
await sleep(1500);
console.log("AFTER-ESC", JSON.stringify({ bar: await p.$(".bar[role=toolbar][aria-label=\"Replay player\"]") != null, badge: await p.$(".badge") != null, liveStage: live.slots.map((s) => s.stage) }));
await p.screenshot({ path: path.join(OUT, "replay-exit.png") });
console.log("ERRORS", errors.length);
await browser.close();
process.exit(errors.length ? 1 : 0);
