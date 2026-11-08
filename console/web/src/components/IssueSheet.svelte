<script lang="ts">
  import Sheet from "./Sheet.svelte";
  import Glyph from "./Glyph.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { issueAction } from "../lib/api";
  import { safeUrl, stripTag } from "../lib/format";

  let { n }: { n: number } = $props();
  const issue = $derived(store.snap.github?.issues.find((i) => i.n === n) ?? null);
  const ro = $derived(store.snap.readonly);
  const url = $derived(safeUrl(issue?.url));
  const tagOf = (d: number): string => store.snap.github?.issues.find((i) => i.n === d)?.tag ?? `#${d}`;
  const close = () => (ui.sheet = null);
  type Act = "queue" | "unqueue" | "skip" | "unskip";
  const acts = $derived.by((): { a: Act; label: string }[] => {
    const c = issue?.class;
    if (!c || c === "running") return [];
    const out: { a: Act; label: string }[] = [];
    if (c === "queued") out.push({ a: "unqueue", label: "remove from queue" });
    else if (c !== "skipped") out.push({ a: "queue", label: c === "failed" ? "retry (queue)" : "queue now" });
    if (c === "skipped") out.push({ a: "unskip", label: "unskip" });
    else out.push({ a: "skip", label: "skip" });
    return out;
  });
  async function go(a: Act) {
    const r = await issueAction(n, a);
    if (r.ok) close();
  }
</script>

<Sheet title={issue?.tag ?? `#${n}`} onclose={close}>
  {#if issue}
    <p class="t">{stripTag(issue.title)}</p>
    <p class="m mono">{issue.class}{issue.milestone ? ` · ${issue.milestone}` : ""}{issue.priority ? ` · ${issue.priority}` : ""}{issue.order != null ? ` · #${issue.order}` : ""}</p>
    {#if issue.reason}<p class="r">{issue.reason}</p>{/if}
    {#if issue.deps.length}<p class="d mono"><Glyph name="chain" /> {issue.deps.map(tagOf).join("  ")}</p>{/if}
    {#if url}<p class="l"><a href={url} target="_blank" rel="noopener noreferrer">issue #{issue.n} <Glyph name="ext" size={11} /></a></p>{/if}
    <div class="row">
      {#each acts as x (x.a)}
        <button class="btn" disabled={ro} onclick={() => void go(x.a)}>{#if ro}<Glyph name="lock" />{/if} {x.label}</button>
      {/each}
      {#if acts.length === 0}<span class="r">lane {issue.claimed_by ?? ""} is working on it</span>{/if}
    </div>
  {:else}
    <p class="r">Issue not in the list.</p>
  {/if}
</Sheet>

<style>
  .t { margin: 0 0 8px; font-size: 15px; line-height: 1.4; }
  .m { margin: 0 0 10px; font-size: 12px; color: var(--text-dim); }
  .r { margin: 0 0 10px; font-size: 12.5px; color: var(--text-dim); }
  .d { margin: 0 0 10px; font-size: 12px; display: flex; gap: 8px; align-items: center; }
  .l { margin: 0 0 16px; font-size: 12.5px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .btn { min-height: 44px; padding: 0 18px; border-radius: 10px; border: 1px solid var(--hair); background: transparent; letter-spacing: 0.02em; display: inline-flex; gap: 8px; align-items: center; }
  .btn:first-child:not(:disabled) { background: var(--top); border-color: var(--top); color: var(--line); font-weight: 600; }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
