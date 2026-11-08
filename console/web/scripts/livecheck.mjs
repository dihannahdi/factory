// Serves contracts/fixtures/live/state.json as the snapshot and asserts there are zero page errors.
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.argv[2] ?? "http://localhost:5173";
const state = fs.readFileSync("../../contracts/fixtures/live/state.json", "utf8");
const b = await chromium.launch();
let bad = 0;
for (const reduced of [false, true]) {
  const c = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: reduced ? "reduce" : "no-preference" });
  const p = await c.newPage();
  p.on("pageerror", (e) => { bad++; console.log("PAGEERROR", e.message.slice(0, 200)); });
  p.on("console", (m) => { if (m.type() === "error" && !/ERR_FAILED/.test(m.text())) { bad++; console.log("CONSOLE", m.text().slice(0, 200)); } });
  await p.route("**/api/state", (r) => r.fulfill({ status: 200, contentType: "application/json", body: state }));
  await p.route("**/api/stream", (r) => r.abort());
  await p.goto(BASE);
  await p.waitForTimeout(7000); // long enough for the poll fallback to re-apply the snapshot
  const lanes = await p.$$eval("article.lane", (a) => a.map((x) => [x.classList.contains("dormant") ? "parked" : "live", x.querySelector(".stage")?.textContent?.trim()]));
  const pulse = await p.$$eval(".cell", (a) => a.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
  const recent = await p.$eval(".recent ol", (o) => o.textContent.replace(/\s+/g, " ").trim().slice(0, 80));
  console.log(reduced ? "reduced" : "normal ", JSON.stringify(lanes), "|", pulse.join(" | "), "|", recent);
  await p.screenshot({ path: `screenshots/live-fixture${reduced ? "-rm" : ""}.png` });
  await c.close();
}
await b.close();
console.log(bad === 0 ? "OK: zero page errors" : `FAIL: ${bad} errors`);
process.exit(bad === 0 ? 0 : 1);
