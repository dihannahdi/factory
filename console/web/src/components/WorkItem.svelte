<script lang="ts">
  // The issue as an object: an ingot until review, a sealed crate from pr on. It is accent-topped
  // while an agent works on it, because the item is exactly where the agent is.
  import Faces from "./Faces.svelte";
  import { box, rotBox, line3, topMatrix } from "../lib/iso";
  import type { Face } from "../lib/iso";
  import { anim, lanes } from "../lib/anim.svelte";
  import { store } from "../lib/store.svelte";
  import { laneVM } from "../lib/lanes";
  import { cableAt, stackTop } from "../lib/layout";

  let { k }: { k: number } = $props();
  const vm = $derived(laneVM(store.snap.slots[k], store.now));
  const A = $derived(lanes[k]);
  const top = $derived(stackTop(store.snap.metrics?.merged_7d ?? 0));

  const item = $derived.by(() => {
    if (!vm.hasIssue || A.o < 0.03) return null;
    const crate = vm.stageIdx >= 5;
    // while CI is pending the crate creeps and sways on the ropeway
    const pending = vm.stage === "ci" && (vm.lamps.length === 0 || vm.lamps.some((l) => l === "run" || l === "wait"));
    const sx = pending && !anim.reduced ? Math.sin(anim.t * 0.9) * 0.45 : 0;
    const sz = pending && !anim.reduced ? Math.sin(anim.t * 2.3) * 0.07 : 0;
    const topTone = vm.working ? ("acc" as const) : ("s1" as const);
    let faces: Face[];
    let labelZ: number;
    let hangers = "";
    let deck: Face[] = [];
    if (!crate) {
      faces = rotBox(A.x, A.y, A.z, 3.5, 1.8, 0.8, A.yaw, { top: topTone });
      labelZ = A.z + 0.8;
    } else {
      faces = [
        ...box(A.x + sx - 0.9, A.y - 0.9, A.z + sz, 1.8, 1.8, 1.5, { top: topTone }),
        ...box(A.x + sx - 0.16, A.y - 0.94, A.z + sz - 0.02, 0.32, 1.88, 1.54, { top: "s3", left: "s3", right: "s4" }),
      ];
      labelZ = A.z + sz + 1.5;
      if (vm.stageIdx <= 6) {
        const cz = cableAt(k, top, A.x);
        hangers = line3([[A.x + sx - 0.75, A.y, A.z + sz + 1.5], [A.x, A.y, cz]]) + line3([[A.x + sx + 0.75, A.y, A.z + sz + 1.5], [A.x, A.y, cz]]);
      } else if (vm.stageIdx >= 8) {
        deck = box(A.x - 1.15, A.y - 1.15, A.z - 0.2, 2.3, 2.3, 0.2, { top: "s2", left: "s3", right: "s4" });
      }
    }
    return { faces, deck, labelZ, hangers, upright: A.yaw < 0.2, sx };
  });
</script>

{#if item}
  <g opacity={A.o} data-part={`item-${k + 1}`}>
    {#if item.hangers}<path d={item.hangers} class="cable" />{/if}
    <Faces faces={item.deck} />
    <Faces faces={item.faces} />
    {#if item.upright && vm.tag}
      <text class="tag" class:lit={vm.working} transform={topMatrix(A.x + item.sx, A.y + 0.07, item.labelZ + 0.01)} font-size="0.86" text-anchor="middle" dominant-baseline="central">{vm.tag}</text>
    {/if}
  </g>
{/if}

<style>
  .cable { fill: none; stroke: var(--shade-1); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .tag { fill: var(--line); font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; font-weight: 600; }
  .tag.lit { fill: var(--accent-ink); }
</style>
