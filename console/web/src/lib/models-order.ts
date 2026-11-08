// Power-cell ordering. control.models is the ordered fallback list (1..5 ids); the rack shows
// every free model, selected cells first in fallback order, spare cells after.
import type { FreeModel } from "./types";

export const MAX_MODELS = 5;

export interface Cell {
  id: string;
  name: string;
  on: boolean;
  idx: number; // 1-based fallback position, 0 when off
  trains: boolean;
  /** Not documented zero-retention: trains, or kept by the provider. Unknown (null) counts as "unknown", see `policy`. */
  exposed: boolean;
  /** Paid OpenCode Go model (counts against the flat plan's budget). */
  paid: boolean;
  policy: "zero" | "exposed" | "unknown";
}

const policyOf = (m: FreeModel): Cell["policy"] =>
  m.trains_on_data === true || m.zero_retention === false ? "exposed" : m.zero_retention === true && m.trains_on_data !== null ? "zero" : "unknown";

const cellOf = (m: FreeModel, paid: boolean, on: boolean, idx: number): Cell => {
  const policy = policyOf(m);
  return { id: m.id, name: m.name, on, idx, trains: m.trains_on_data === true, exposed: policy === "exposed", paid, policy };
};

/** Free and paid (Go) models in one rack: selected first in fallback order, spare after (free, then paid). */
export function cells(free: FreeModel[], selected: string[], paid: FreeModel[] = []): Cell[] {
  const all = [...free.map((m) => ({ m, paid: false })), ...paid.map((m) => ({ m, paid: true }))];
  const byId = new Map(all.map((x) => [x.m.id, x]));
  const on = selected.filter((id, i) => byId.has(id) && selected.indexOf(id) === i);
  const out: Cell[] = on.map((id, i) => cellOf(byId.get(id)!.m, byId.get(id)!.paid, true, i + 1));
  for (const x of all) if (!on.includes(x.m.id)) out.push(cellOf(x.m, x.paid, false, 0));
  return out;
}

/** Add an unused model at the end, or remove a used one (never the last). Returns the same list when nothing changes. */
export function toggle(selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.length <= 1 ? selected : selected.filter((x) => x !== id);
  return selected.length >= MAX_MODELS ? selected : [...selected, id];
}

export function moveTo(selected: string[], id: string, to: number): string[] {
  const from = selected.indexOf(id);
  if (from < 0) return selected;
  const t = Math.max(0, Math.min(selected.length - 1, to));
  if (t === from) return selected;
  const next = selected.slice();
  next.splice(from, 1);
  next.splice(t, 0, id);
  return next;
}

export const moveBy = (selected: string[], id: string, delta: number): string[] => moveTo(selected, id, selected.indexOf(id) + delta);

export const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
