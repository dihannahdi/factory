// Fails the build when any Svelte/TS source uses {@html ...}: every string from the API is untrusted.
import fs from "node:fs";
import path from "node:path";
const bad = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(svelte|ts|js|html)$/.test(e.name) && /\{@html\b/.test(fs.readFileSync(p, "utf8"))) bad.push(p);
  }
})("src");
if (bad.length) { console.error("check:html failed, {@html} found in:\n" + bad.join("\n")); process.exit(1); }
console.log("check:html ok");
