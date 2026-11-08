<script lang="ts">
  // The shared MAIN STACK: one slab per merge (7 days), padded landing spots for the three lanes, a
  // lift mast and the health beacon. Late-stage work items are painted here so they sit on the stack.
  import Faces from "./Faces.svelte";
  import WorkItem from "./WorkItem.svelte";
  import { box, cylV, faceMatrix, plate, project, ringArc } from "../lib/iso";
  import type { Face } from "../lib/iso";
  import { anim } from "../lib/anim.svelte";
  import { store } from "../lib/store.svelte";
  import { laneVM } from "../lib/lanes";
  import { MAST, STACK, padY, stackTop, stageProgress } from "../lib/layout";

  let { only = null }: { only?: number | null } = $props();

  const merged = $derived(store.snap.metrics?.merged_7d ?? 0);
  const top = $derived(stackTop(merged));
  const n = $derived(Math.min(Math.max(0, merged), STACK.max));
  const vms = $derived([0, 1, 2].map((k) => laneVM(store.snap.slots[k], store.now)));
  const halted = $derived(store.snap.halt != null && store.snap.control.resume_ack !== store.snap.halt.id);
  const healthy = $derived((store.snap.github?.health.ok ?? true) && !halted);

  const body = $derived.by(() => {
    const f: Face[] = [...box(STACK.x - 0.4, STACK.y - 0.4, 0, STACK.w + 0.8, STACK.d + 0.8, 0.5, { top: "s3", left: "s2", right: "s3" })];
    f.push(...box(STACK.x, STACK.y, 0.5, STACK.w, STACK.d, STACK.base - 0.5, { top: "s1", left: "s2", right: "s3" }));
    for (let i = 0; i < n; i++) {
      const odd = i % 2 === 1;
      f.push(...box(STACK.x + 0.25, STACK.y + 0.25, STACK.base + i * STACK.per, STACK.w - 0.5, STACK.d - 0.5, STACK.per, { top: odd ? "s1" : "top", left: odd ? "s3" : "s2", right: odd ? "s4" : "s3" }));
    }
    return f;
  });
  const pads = $derived<Face[]>([0, 1, 2].map((k) => plate(49.55, padY(k) - 0.95, top + 0.004, 1.9, 1.9, "s3")));
  const rails = $derived<Face[]>([0, 1, 2].flatMap((k) => box(52.0, padY(k) - 0.1, top, 0.18, 0.18, 4.2, { top: "s1" })));
  const mast = $derived<Face[]>([...cylV(MAST.x, MAST.y, top, 0.3, 4.9), ...cylV(MAST.x, MAST.y, top + 4.9, 0.62, 0.55, 12, { top: healthy ? "top" : "s4" })]);
  const lampAt = $derived(project(MAST.x, MAST.y, top + 5.2));
  const pulse = $derived(anim.reduced ? 1 : 0.8 + 0.2 * Math.sin(anim.t * 2.2));
  const warn = $derived(project(MAST.x, MAST.y, top + 7.1));
  const rings = $derived.by(() => {
    void anim.t;
    return vms.map((v, k) => {
      if (!v.working || (v.stage !== "merge" && v.stage !== "deploy")) return null;
      const el = v.slot.stage_started != null ? store.nowF() - v.slot.stage_started : null;
      const p = stageProgress(el, store.snap.metrics?.stage_median_min, v.stage);
      return { base: ringArc(50.5, padY(k), top + 0.03, 1.55, 1), arc: ringArc(50.5, padY(k), top + 0.03, 1.55, Math.min(1, p)), o: p >= 1 && !anim.reduced ? 0.55 + 0.45 * Math.sin(anim.t * 2.2) : 1 };
    });
  });
  const glowPads = $derived(vms.map((v, k) => (v.working && (v.stage === "merge" || v.stage === "deploy" || v.stage === "live") ? plate(49.0, padY(k) - 1.45, top + 0.01, 2.9, 2.9).d : "")));
</script>

<g class="stack">
  <Faces faces={body} />
  <text class="eng" transform={faceMatrix("left", STACK.x + 0.3, STACK.y + STACK.d + 0.4, 0.42)} font-size="0.8">{merged}</text>
  <Faces faces={pads} />
  {#each glowPads as g, i (i)}{#if g}<path d={g} class="glow" />{/if}{/each}
  {#each rings as r, i (i)}{#if r}<path d={r.base} class="ring" /><path d={r.arc} class="arc" opacity={r.o} />{/if}{/each}
  <Faces faces={rails} />
  <Faces faces={mast} />
  {#if healthy}
    <circle cx={lampAt[0]} cy={lampAt[1]} r={15 * pulse} class="beam" />
    <circle cx={lampAt[0]} cy={lampAt[1]} r={7} class="beam in" />
  {:else}
    <g class="warn" aria-hidden="true">
      <path d="M{warn[0]} {warn[1] - 11}L{warn[0] + 10.5} {warn[1] + 7}L{warn[0] - 10.5} {warn[1] + 7}Z" />
      <path d="M{warn[0]} {warn[1] - 4}V{warn[1] + 1.5}M{warn[0]} {warn[1] + 3.8}v0.4" />
    </g>
  {/if}
  {#each vms as v, k (k)}
    {#if v.hasIssue && v.stageIdx >= 7 && (only == null || only === k)}<WorkItem {k} />{/if}
  {/each}
</g>

<style>
  .glow { fill: url(#g-acc); opacity: var(--glow); }
  .ring { fill: none; stroke: var(--text-dim); stroke-width: 1; stroke-dasharray: 1.5 3; vector-effect: non-scaling-stroke; opacity: 0.6; }
  .arc { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .beam { fill: var(--top); opacity: 0.14; }
  .beam.in { opacity: 0.35; }
  .warn path { fill: none; stroke: var(--text-dim); stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
  .eng { fill: var(--line); font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; font-weight: 600; opacity: 0.8; }
</style>
