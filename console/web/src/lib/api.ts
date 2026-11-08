// Thin fetch layer. Same-origin cookies, JSON only, 401 anywhere sends the user to the login view.
import { store, ui } from "./store.svelte";

export interface ApiResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

export async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: Record<string, unknown> | null = null;
    if (res.status !== 204) {
      try { data = (await res.json()) as Record<string, unknown>; } catch { data = null; }
    }
    if (res.status === 401 && path !== "/api/login") store.auth = "login";
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

const REASON: Record<string, string> = {
  readonly: "read-only",
  auth: "session expired",
  origin: "origin rejected",
  invalid: "invalid",
  no_run: "lane is not running",
};

/** Human line for a failed POST (kept short; the API's `error` code is the source). */
export function failure(r: ApiResult): string {
  if (r.status === 0) return "not connected";
  const code = typeof r.data?.error === "string" ? r.data.error : "";
  const field = typeof r.data?.field === "string" ? ` (${r.data.field})` : "";
  return (REASON[code] ?? (code || `failed ${r.status}`)) + field;
}

async function post(path: string, body: unknown): Promise<ApiResult> {
  const r = await request("POST", path, body);
  if (!r.ok) ui.say(failure(r));
  else if (r.data && "control" in r.data) store.ingest("control", r.data.control);
  return r;
}

export const setAgents = async (n: number) => {
  ui.pendingAgents = n;
  const r = await post("/api/control", { agents: n });
  ui.pendingAgents = null;
  return r;
};
export const setModels = (models: string[]) => post("/api/control", { models });
export const setPaused = (paused: boolean) => post("/api/control", { paused });
export const resumeHalt = (id: string) => post("/api/control", { resume_ack: id });
export const issueAction = (n: number, action: "queue" | "unqueue" | "skip" | "unskip") => post(`/api/issues/${n}`, { action });
export const stopLane = (k: number, skip: boolean) => post(`/api/slots/${k}/interrupt`, { action: "stop", skip });
export const steerLane = (k: number, message: string) => post(`/api/slots/${k}/interrupt`, { action: "steer", message });

export async function login(email: string, password: string): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
  const r = await request("POST", "/api/login", { email, password });
  if (r.ok) return { ok: true };
  if (r.status === 429) return { ok: false, error: "rate_limited", retryAfter: Number(r.data?.retry_after ?? 60) };
  if (r.status === 0) return { ok: false, error: "network" };
  return { ok: false, error: String(r.data?.error ?? "bad_credentials") };
}

export async function logout(): Promise<void> {
  await request("POST", "/api/logout");
  store.auth = "login";
}
