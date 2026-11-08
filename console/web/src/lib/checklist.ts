// Pure text logic for the inspect drawer's checklist: a short headline per requirement and the files
// its evidence names, so a row reads in one line and the full sentence waits behind a click.

/** One line, control characters and runs of space collapsed: what `headline` compares against. */
export const flat = (s: string | null | undefined): string => (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The requirement up to its first clause break (": ", " — ", "; "), when that leaves a real phrase
 * (10+ chars). "Hourly usage profile: convert …" -> "Hourly usage profile". Otherwise the whole line;
 * CSS cuts it to one line.
 */
export function headline(item: string): string {
  const t = flat(item);
  let cut = t.length;
  for (const sep of [": ", " — ", "; "]) {
    const i = t.indexOf(sep);
    if (i >= 10 && i < cut) cut = i;
  }
  return t.slice(0, cut);
}

const FILE_RE = /[A-Za-z0-9_.\-/\\]+\.(?:rs|ts|tsx|js|mjs|svelte|astro|sql|md|json|toml|ya?ml|sh|py|csv|html|css)(?![A-Za-z0-9])/g;

/** File names the evidence points at, by base name, first mention first, no duplicates. */
export function evidenceFiles(evidence: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of flat(evidence).matchAll(FILE_RE)) {
    const p = m[0].replace(/[\\/]+$/, "");
    const base = p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
    if (base && !base.startsWith(".") && !out.includes(base)) out.push(base);
  }
  return out;
}
