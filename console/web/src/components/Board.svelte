<script lang="ts">
  // Secondary view: every issue the pipeline knows, in columns by class. Tap a card for its actions.
  import Glyph from "./Glyph.svelte";
  import { onMount } from "svelte";
  import { store, ui } from "../lib/store.svelte";
  import type { GhIssue, IssueClass } from "../lib/types";
  import { stripTag, truncate } from "../lib/format";

  const COLS: IssueClass[] = ["running", "queued", "eligible", "blocked", "taken", "failed", "skipped"];
  const issues = $derived(store.snap.github?.issues ?? []);
  const cols = $derived(
    COLS.map((c) => {
      const items = issues.filter((i) => i.class === c);
      items.sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.n - b.n);
      return { c, items };
    }),
  );
  const tagOf = (n: number): string => issues.find((i) => i.n === n)?.tag ?? `#${n}`;
  const close = () => (ui.boardOpen = false);
  let drawer: HTMLElement;
  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    drawer.focus();
    return () => opener?.focus?.();
  });
  function open(i: GhIssue) { ui.sheet = { kind: "issue", n: i.n }; }
</script>

<div class="veil" role="presentation" onpointerdown={(e) => { if (e.target === e.currentTarget) close(); }}>
  <div class="drawer" bind:this={drawer} role="dialog" aria-modal="true" aria-label="Issue board" tabindex="-1" onkeydown={(e) => { if (e.key === "Escape" && !ui.sheet) close(); }}>
    <header>
      <h2 class="serif">Board</h2>
      <span class="cnt mono">{issues.length}</span>
      <button class="x" onclick={close} aria-label="Close board"><Glyph name="cross" size={14} /></button>
    </header>
    <div class="cols">
      {#each cols as col (col.c)}
        <section class="col" aria-label={`${col.c}, ${col.items.length} ${col.items.length === 1 ? "issue" : "issues"}`}>
          <h3><span>{col.c}</span><span class="mono n">{col.items.length}</span></h3>
          <ul>
            {#each col.items as i (i.n)}
              <li>
                <button class="card" onclick={() => open(i)} title={i.title}>
                  <span class="r1"><b class="mono">{i.tag ?? `#${i.n}`}</b>{#if i.order != null}<span class="o mono">#{i.order}</span>{/if}</span>
                  <span class="t">{truncate(stripTag(i.title), 70)}</span>
                  <span class="r3 mono">{i.milestone ?? "—"}·{i.priority ?? "—"}{#if i.deps.length}<span class="dp"><Glyph name="chain" size={11} /> {i.deps.slice(0, 3).map(tagOf).join(" ")}</span>{/if}</span>
                </button>
              </li>
            {/each}
            {#if col.items.length === 0}<li class="empty mono">·</li>{/if}
          </ul>
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .veil { position: fixed; inset: 0; z-index: 50; background: color-mix(in srgb, var(--paper) 60%, transparent); animation: fade 0.16s; }
  .drawer { position: absolute; top: 0; right: 0; bottom: 0; width: min(920px, 100vw); background: var(--paper); border-left: 1px solid var(--hair); display: flex; flex-direction: column; animation: in 0.26s cubic-bezier(0.2, 0.8, 0.2, 1); outline: none; box-shadow: -24px 0 60px rgba(0, 0, 0, 0.35); padding-bottom: env(safe-area-inset-bottom); }
  header { display: flex; align-items: baseline; gap: 12px; padding: 16px 20px 12px; padding-top: calc(16px + env(safe-area-inset-top)); }
  h2 { margin: 0; font-size: 28px; font-weight: 400; }
  .cnt { color: var(--text-dim); font-size: 13px; }
  .x { margin-left: auto; align-self: center; width: 40px; height: 40px; display: grid; place-items: center; background: transparent; border: 1px solid var(--hair); border-radius: 8px; }
  .cols { flex: 1; display: grid; grid-auto-flow: column; grid-auto-columns: 232px; gap: 10px; padding: 4px 20px 20px; overflow: auto; scroll-snap-type: x proximity; }
  .col { min-height: 0; display: flex; flex-direction: column; scroll-snap-align: start; }
  h3 { margin: 0 0 8px; display: flex; justify-content: space-between; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-dim); font-weight: 500; padding: 0 2px; position: sticky; top: 0; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; align-content: start; overflow-y: auto; min-height: 0; padding-right: 2px; }
  .card { width: 100%; text-align: left; display: grid; gap: 3px; padding: 9px 11px; background: var(--card); border: 1px solid var(--hair); border-radius: 9px; min-height: 44px; }
  .card:hover { border-color: var(--text-dim); background: var(--card-2); }
  .r1 { display: flex; justify-content: space-between; font-size: 12px; }
  .r1 b { font-weight: 600; letter-spacing: 0.02em; }
  .o { color: var(--text-dim); }
  .t { font-size: 12px; line-height: 1.35; color: var(--text); display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
  .r3 { font-size: 10.5px; color: var(--text-dim); display: flex; gap: 8px; align-items: center; }
  .dp { display: inline-flex; gap: 4px; align-items: center; }
  .empty { color: var(--shade-3); padding: 6px 4px; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes in { from { transform: translateX(40px); opacity: 0; } }
  @media (max-width: 760px) {
    .cols { grid-auto-columns: 78vw; padding: 4px 14px 20px; }
    .card { min-height: 52px; }
  }
</style>
