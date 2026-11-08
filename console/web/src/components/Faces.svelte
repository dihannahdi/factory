<script lang="ts">
  import type { Face } from "../lib/iso";
  let { faces, cls = "" }: { faces: Face[]; cls?: string } = $props();
</script>

{#each faces as f, i (i)}<path d={f.d} class="f t-{f.tone} {cls}" />{/each}
