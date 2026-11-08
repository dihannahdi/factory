#!/usr/bin/env node
// Sets the console login. Run as root on the server:
//   node passwd.mjs            (prompts; password is not echoed on a TTY)
//   printf 'me@x.com\nlong password here\n' | node passwd.mjs
// Writes HC_ETC_DIR/auth.json (scrypt N=16384 r=8 p=1, 16-byte salt) and creates `secret` if absent.
// Prints nothing secret.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hashPassword } from "../lib/auth.mjs";
import { writeFileAtomic } from "../lib/files.mjs";

const etcDir = process.env.HC_ETC_DIR || "/etc/factory-console";
const group = process.env.HC_GROUP || "factory-console";

function readLinesPiped() {
  const text = fs.readFileSync(0, "utf8").split(/\r?\n/);
  return [text[0] ?? "", text[1] ?? ""];
}

function ask(prompt, { echo }) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    stderr.write(prompt);
    let buf = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\u0003") { cleanup(); stderr.write("\n"); return reject(new Error("cancelled")); }
        if (ch === "\r" || ch === "\n") { cleanup(); stderr.write("\n"); return resolve(buf); }
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        buf += ch;
        if (echo) stderr.write(ch);
      }
    };
    const cleanup = () => { stdin.removeListener("data", onData); stdin.setRawMode?.(false); stdin.pause(); };
    stdin.on("data", onData);
  });
}

function groupGid(name) {
  try {
    for (const line of fs.readFileSync("/etc/group", "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === name) return Number(f[2]);
    }
  } catch { /* no /etc/group (not Linux) */ }
  return null;
}

let email, password;
if (process.stdin.isTTY) {
  email = (await ask("email: ", { echo: true })).trim();
  password = await ask("password (min 12 chars): ", { echo: false });
  const again = await ask("again: ", { echo: false });
  if (again !== password) { console.error("passwords differ"); process.exit(1); }
} else {
  [email, password] = readLinesPiped();
  email = email.trim();
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) { console.error("invalid email"); process.exit(1); }
if (password.length < 12 || password.length > 1024) { console.error("password must be 12 to 1024 characters"); process.exit(1); }

fs.mkdirSync(etcDir, { recursive: true, mode: 0o750 });
const hash = await hashPassword(password);
writeFileAtomic(path.join(etcDir, "auth.json"), JSON.stringify({ email, hash }) + "\n", 0o640);

const secretFile = path.join(etcDir, "secret");
let createdSecret = false;
try {
  fs.writeFileSync(secretFile, crypto.randomBytes(32), { flag: "wx", mode: 0o640 });
  createdSecret = true;
} catch (e) {
  if (e.code !== "EEXIST") throw e;
}

// Make the files readable by the service user's group when we are root and the group exists.
const gid = process.getuid?.() === 0 ? groupGid(group) : null;
if (gid !== null) {
  for (const p of [etcDir, path.join(etcDir, "auth.json"), secretFile]) fs.chownSync(p, 0, gid);
}
console.log(`auth.json written for ${email}; secret ${createdSecret ? "created" : "kept"}${gid === null ? " (group ownership not changed)" : ""}`);
