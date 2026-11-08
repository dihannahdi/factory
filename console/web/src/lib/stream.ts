// SSE with exponential reconnect. After 3 failed reconnects we also poll /api/state every 3 s
// (same reducer) while SSE keeps retrying in the background. 401 anywhere shows the login view.
import { backoffDelay } from "./format";
import { STREAM_KEYS } from "./types";
import { request } from "./api";
import { heldByReplay, store } from "./store.svelte";

const POLL_MS = 3000;
const POLL_AFTER = 3;

let es: EventSource | null = null;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let running = false;

async function pollOnce(): Promise<void> {
  const r = await request("GET", "/api/state");
  if (r.status === 401) { stopStream(); store.auth = "login"; return; }
  if (r.ok && r.data) {
    if (store.ingest("snapshot", r.data)) store.link = es && es.readyState === EventSource.OPEN ? "live" : "poll";
  } else if (failures >= POLL_AFTER) store.link = "offline";
}

function startPoll(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void pollOnce(), POLL_MS);
}
function stopPoll(): void {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

function connect(): void {
  if (!running) return;
  es?.close();
  const src = new EventSource("/api/stream");
  es = src;
  if (failures < POLL_AFTER) store.link = "connecting";
  for (const key of STREAM_KEYS) {
    src.addEventListener(key, (ev) => {
      let data: unknown;
      try { data = JSON.parse((ev as MessageEvent<string>).data); } catch { return; }
      if (key === "snapshot") { failures = 0; stopPoll(); store.link = "live"; }
      if (heldByReplay(key, data, store.replayLane)) return; // that lane is playing a recording
      store.ingest(key, data);
    });
  }
  src.onerror = () => {
    src.close();
    if (es === src) es = null;
    void onFail();
  };
}

async function onFail(): Promise<void> {
  if (!running) return;
  failures++;
  await pollOnce(); // also how we learn the cookie expired (EventSource hides the status)
  if (!running || store.auth === "login") return;
  if (failures >= POLL_AFTER) startPoll();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, backoffDelay(failures - 1));
}

export function startStream(): void {
  if (running) return;
  running = true;
  failures = 0;
  connect();
}

export function stopStream(): void {
  running = false;
  es?.close();
  es = null;
  clearTimeout(retryTimer);
  stopPoll();
}

/** First load: one GET decides between the login view and the live view. */
export async function boot(): Promise<void> {
  const r = await request("GET", "/api/state");
  if (r.status === 401) { store.auth = "login"; return; }
  if (r.ok && r.data) {
    store.ingest("snapshot", r.data);
    store.auth = "ok"; // a 200 from /api/state is the proof of a session, whatever the payload looked like
    store.link = "poll";
  }
  stopStream(); // after a login the old (401'd) stream must not linger
  startStream();
}
