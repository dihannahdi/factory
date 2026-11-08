<script lang="ts">
  // The last outcomes as one thin line of marks, newest first.
  import Glyph from "./Glyph.svelte";
  import { store } from "../lib/store.svelte";
  import { OUTCOME_ICON, fmtAgo, safeUrl } from "../lib/format";

  const rows = $derived(
    store.snap.recent.slice(0, 20).map((o) => {
      const issue = store.snap.github?.issues.find((i) => i.n === o.issue);
      return { o, tag: issue?.tag ?? `#${o.issue}`, url: safeUrl(o.url), ago: fmtAgo(o.ts, store.now) };
    }),
  );
</script>

<footer class="recent" aria-label="Recent outcomes">
  <h2 class="serif">Recent</h2>
  <ol class="mono">
    {#each rows as r, i (r.o.ts + ":" + r.o.issue + ":" + i)}
      <li title={`${r.o.outcome} · lane ${r.o.slot}`}>
        <Glyph name={OUTCOME_ICON[r.o.outcome] ?? "dots"} size={12} />
        {#if r.url}<a href={r.url} target="_blank" rel="noopener noreferrer">{r.tag}</a>{:else}<span>{r.tag}</span>{/if}
        <span class="w">{r.o.outcome.replace("_", " ")}</span>
        <time class="ago">{r.ago}</time>
      </li>
    {/each}
    {#if rows.length === 0}<li class="none">no outcomes yet</li>{/if}
  </ol>
</footer>

<style>
  .recent { display: flex; align-items: center; gap: 18px; padding: 8px 20px; padding-bottom: calc(8px + env(safe-area-inset-bottom)); border-top: 1px solid var(--hair); background: var(--paper); min-height: 46px; }
  h2 { margin: 0; font-size: 20px; font-weight: 400; flex: none; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; gap: 20px; overflow-x: auto; scrollbar-width: none; font-size: 12px; white-space: nowrap; mask-image: linear-gradient(90deg, #000 90%, transparent); -webkit-mask-image: linear-gradient(90deg, #000 90%, transparent); flex: 1; }
  ol::-webkit-scrollbar { display: none; }
  li { display: inline-flex; align-items: center; gap: 7px; flex: none; }
  .w { color: var(--text-dim); }
  .ago { color: var(--text-dim); font-size: 11px; }
  a { text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
  .none { color: var(--text-dim); }
  @media (max-width: 760px) { .recent { padding: 8px 14px; padding-bottom: calc(76px + env(safe-area-inset-bottom)); } h2 { font-size: 18px; } }
</style>
