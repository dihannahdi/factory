// Dev-only extra routes for the "alive" pass. Each builder owns one file; this file only chains them.
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleInspect } from "./mock-inspect";
import { handleReplay } from "./mock-replay";

export type Send = (res: ServerResponse, code: number, body?: unknown) => void;
export interface Ctx { sim: string; send: Send }
/** Returns true when a route handled the request. */
export async function extraRoutes(req: IncomingMessage, res: ServerResponse, url: URL, ctx: Ctx): Promise<boolean> {
  return (await handleInspect(req, res, url, ctx)) || (await handleReplay(req, res, url, ctx));
}
