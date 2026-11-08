<script lang="ts">
  // Per-tool actions, drawn inside the lane's <g> in lane coordinates. New activity items become
  // short gestures at the station the agent is at (see lib/actions.svelte.ts). Animation bookkeeping
  // lives in a plain engine object; the only reactive reads are the activity list (in an untracked
  // effect) and the animation clock (in the $derived), so nothing here can loop.
  import { onDestroy, untrack } from "svelte";
  import { anim } from "../lib/anim.svelte";
  import { store } from "../lib/store.svelte";
  import { stackTop } from "../lib/layout";
  import { LaneActions, NONE, anchorCtx, bathCtx, stillPrims } from "../lib/actions.svelte";
  import type { ActionKind, Ctx, Prim } from "../lib/actions.svelte";

  let { k }: { k: number } = $props();

  const eng = new LaneActions();
  const NO_ITEMS: never[] = [];
  const STILL_MS = 600;

  // reduced motion: the frozen poses that are lit right now
  let lit = $state.raw<{ id: number; prims: Prim[] }[]>([]);
  let litId = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function ctxFor(kind: ActionKind): Ctx {
    const s = store.snap.slots[k];
    const top = stackTop(store.snap.metrics?.merged_7d ?? 0);
    return kind === "test" ? bathCtx(k) : anchorCtx(s.stage, k, top);
  }

  $effect(() => {
    const items = store.snap.activity[String(k + 1)] ?? NO_ITEMS;
    untrack(() => {
      const reduced = anim.reduced;
      const fresh = eng.ingest(items, store.nowF() * 1000, !reduced);
      if (!reduced || fresh.length === 0) return;
      const add = fresh.filter((a) => a.kind !== "tick").slice(-3).map((a) => ({ id: ++litId, prims: stillPrims(a.kind, a.error, ctxFor(a.kind)) }));
      if (add.length === 0) return;
      lit = [...lit, ...add].slice(-3);
      const ids = new Set(add.map((a) => a.id));
      const t = setTimeout(() => { timers.delete(t); lit = lit.filter((l) => !ids.has(l.id)); }, STILL_MS);
      timers.add(t);
    });
  });
  onDestroy(() => { for (const t of timers) clearTimeout(t); timers.clear(); });

  const prims = $derived.by((): Prim[] => {
    if (anim.reduced) return lit.length ? lit.flatMap((l) => l.prims) : NONE;
    const t = anim.t; // the one tracked read: the animation clock
    return eng.frame(t, Date.now(), ctxFor);
  });
</script>

<g class="act" aria-hidden="true">
  {#each prims as q, i (i)}
    <path d={q.d} class={q.cls} transform={q.tf} opacity={q.o} pathLength={q.dr === undefined ? undefined : 1} stroke-dasharray={q.dr === undefined ? undefined : `${q.dr} 1.01`} />
  {/each}
</g>

<style>
  .act { pointer-events: none; }
  .act :global(.a-fl) { fill: var(--top); stroke: none; }
  .act :global(.a-fd) { fill: var(--line); stroke: none; }
  .act :global(.a-bub) { fill: var(--shade-1); stroke: var(--top); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .act :global(.a-ln), .act :global(.a-ln2), .act :global(.a-lnd), .act :global(.a-tick), .act :global(.a-dash), .act :global(.a-jag), .act :global(.a-wave) {
    fill: none; stroke: var(--top); stroke-width: 1.8; vector-effect: non-scaling-stroke; stroke-linecap: round; stroke-linejoin: round;
  }
  .act :global(.a-ln2) { stroke-width: 2.4; }
  .act :global(.a-lnd) { stroke: var(--line); stroke-width: 1.4; }
  .act :global(.a-tick) { stroke-width: 2.6; }
  .act :global(.a-dash) { stroke-width: 1.2; stroke-dasharray: 3 3; }
  .act :global(.a-jag) { stroke-width: 2.2; stroke-linejoin: miter; }
  .act :global(.a-wave) { fill: var(--top); fill-opacity: 0.09; }
  .act :global(.a-ink) { fill: none; stroke: var(--top); stroke-width: 0.22; stroke-linecap: round; }
</style>
