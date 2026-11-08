// Optional mechanical sound design, synthesised with WebAudio: no files, no network.
// Off by default. The AudioContext is created only after a user gesture (autoplay rules) and every
// entry point is a silent no-op when WebAudio is missing or throws.
import type { Item } from "./types";

const KEY = "hc-sound";
export const MAX_PER_SEC = 8;

export type SoundKind = "thunk" | "paper" | "bubbles" | "tick" | "chime" | "gong";

/** Which sound an activity item makes, or null for silence (text, steps, errors, unknown tools). */
export function soundFor(it: Pick<Item, "kind" | "tool" | "target">): SoundKind | null {
  if (it.kind !== "tool") return null;
  switch (it.tool) {
    case "edit": case "write": return "thunk";
    case "read": return "paper";
    case "grep": case "glob": case "list": return "tick";
    case "bash": return /\b(test|nextest|vitest|jest|pytest|check|clippy|build)\b/.test(it.target ?? "") ? "bubbles" : "tick";
    default: return null;
  }
}

/** Sliding-window limiter: at most `max` accepted events per `windowMs`. */
export function makeLimiter(max: number, windowMs = 1000): (nowMs: number) => boolean {
  const stamps: number[] = [];
  return (now) => {
    while (stamps.length && now - stamps[0] >= windowMs) stamps.shift();
    if (stamps.length >= max) return false;
    stamps.push(now);
    return true;
  };
}

/** Hum frequency in Hz for a tokens-per-minute figure: 48 Hz idle, up to ~110 Hz at 60k tokens/min. */
export function humHz(tpm: number): number {
  return 48 + Math.min(62, Math.max(0, tpm) / 1000);
}

interface Prefs { on: boolean; vol: number }
const prefs: Prefs = { on: false, vol: 0.5 };
function loadPrefs(): void {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return;
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o.on === true) prefs.on = true;
    if (typeof o.vol === "number" && Number.isFinite(o.vol)) prefs.vol = Math.min(1, Math.max(0, o.vol));
  } catch { /* storage may be blocked or corrupt */ }
}
function savePrefs(): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}
loadPrefs();

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let hum: { osc: OscillatorNode; gain: GainNode } | null = null;
let humTimer: ReturnType<typeof setInterval> | undefined;
let tpmSource: () => number = () => 0;
let gestured = false;
const allow = makeLimiter(MAX_PER_SEC);

export const isOn = (): boolean => prefs.on;
export const volume = (): number => prefs.vol;
export const hasContext = (): boolean => ctx != null;

function ensure(): boolean {
  if (ctx) return true;
  if (!gestured) return false;
  try {
    const AC = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = prefs.vol;
    master.connect(ctx.destination);
    const len = Math.floor(ctx.sampleRate * 0.5);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = (seed / 0x3fffffff) - 1; }
    return true;
  } catch { ctx = null; master = null; return false; }
}

function ready(): AudioContext | null {
  if (!prefs.on || !ensure() || !ctx || !master) return null;
  try { if (ctx.state === "suspended") void ctx.resume().catch(() => {}); } catch { return null; }
  return ctx;
}

/** Call from any user gesture (click, key). Lets the context be created from then on. */
export function unlock(): void {
  gestured = true;
  if (prefs.on) { ready(); startHum(); }
}

export function setOn(on: boolean): void {
  prefs.on = on;
  savePrefs();
  if (on) { gestured = true; ready(); startHum(); }
  else { stopHum(); try { void ctx?.suspend().catch(() => {}); } catch { /* ignore */ } }
}

export function setVolume(v: number): void {
  prefs.vol = Math.min(1, Math.max(0, v));
  savePrefs();
  try { if (master && ctx) master.gain.setTargetAtTime(prefs.vol, ctx.currentTime, 0.03); } catch { /* ignore */ }
}

/** Where the hum reads its tokens/min from. */
export function setTpmSource(f: () => number): void { tpmSource = f; }

// ---------------------------------------------------------------- voices
function env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}
function osc(c: AudioContext, type: OscillatorType, f0: number, f1: number, t: number, dur: number, peak: number, attack = 0.004): void {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  env(g, t, peak, attack, dur);
  o.connect(g); g.connect(master!);
  o.start(t); o.stop(t + attack + dur + 0.05);
}
function noise(c: AudioContext, t: number, dur: number, peak: number, hz: number, q: number, type: BiquadFilterType = "bandpass"): void {
  if (!noiseBuf) return;
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = noiseBuf;
  f.type = type; f.frequency.value = hz; f.Q.value = q;
  env(g, t, peak, 0.004, dur);
  s.connect(f); f.connect(g); g.connect(master!);
  s.start(t, Math.random() * 0.2, dur + 0.05);
}

function voice(kind: SoundKind, c: AudioContext): void {
  const t = c.currentTime + 0.005;
  switch (kind) {
    case "thunk": osc(c, "sine", 150, 52, t, 0.14, 0.5); noise(c, t, 0.05, 0.12, 400, 0.8, "lowpass"); break;
    case "paper": noise(c, t, 0.16, 0.16, 3200, 0.6); noise(c, t + 0.05, 0.12, 0.08, 5200, 0.7); break;
    case "bubbles":
      for (let i = 0; i < 3; i++) osc(c, "sine", 420 + i * 170 + Math.random() * 60, 900 + i * 260, t + i * 0.07, 0.07, 0.12, 0.006);
      break;
    case "tick": osc(c, "square", 1900, 1500, t, 0.018, 0.05, 0.001); break;
    case "chime": [659.25, 987.77, 1318.5].forEach((f, i) => osc(c, "sine", f, f, t + i * 0.09, 0.9, 0.18, 0.008)); break;
    case "gong":
      osc(c, "sine", 110, 108, t, 2.4, 0.4, 0.02);
      osc(c, "sine", 164, 162, t, 1.8, 0.2, 0.02);
      osc(c, "triangle", 277, 275, t, 1.2, 0.08, 0.02);
      noise(c, t, 0.4, 0.05, 700, 0.5);
      break;
  }
}

/** Play one sound now. Silent when off, locked, unsupported, or over the rate limit (rare sounds always pass). */
export function play(kind: SoundKind): void {
  try {
    const c = ready();
    if (!c) return;
    const rare = kind === "chime" || kind === "gong";
    if (!rare && !allow(Date.now())) return;
    voice(kind, c);
  } catch { /* never let audio break the dashboard */ }
}

// ---------------------------------------------------------------- hum
function startHum(): void {
  if (humTimer) return;
  try {
    const c = ready();
    if (!c || !master) return;
    if (!hum) {
      const o = c.createOscillator(), lp = c.createBiquadFilter(), g = c.createGain();
      o.type = "sawtooth"; o.frequency.value = humHz(0);
      lp.type = "lowpass"; lp.frequency.value = 220;
      g.gain.value = 0.0001;
      o.connect(lp); lp.connect(g); g.connect(master);
      o.start();
      hum = { osc: o, gain: g };
    }
    const upd = () => {
      if (!ctx || !hum || !prefs.on) return;
      const tpm = tpmSource();
      hum.osc.frequency.setTargetAtTime(humHz(tpm), ctx.currentTime, 0.4);
      hum.gain.gain.setTargetAtTime(tpm > 0 ? 0.045 : 0.012, ctx.currentTime, 0.5);
    };
    upd();
    humTimer = setInterval(upd, 1000);
  } catch { /* ignore */ }
}
function stopHum(): void {
  clearInterval(humTimer);
  humTimer = undefined;
  try { if (hum && ctx) hum.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.1); } catch { /* ignore */ }
}

if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as Record<string, unknown>).__hcSound = { hasContext, isOn, play };
