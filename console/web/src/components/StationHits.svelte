<script lang="ts">
  // Invisible hit polygons over the lane's stations. Hover draws a thin neutral outline; a tap (not the
  // end of a drag) opens the inspect drawer. Double-click still belongs to Machine's fly-to, so the
  // drawer waits a beat and a second press cancels it. Keyboard: Tab to a station, Enter or Space.
  import { onDestroy } from "svelte";
  import { project } from "../lib/iso";
  import { ui } from "../lib/store.svelte";
  import { hull, isTap } from "../lib/inspect-api";
  import { BELT_W, beltCy, laneY0 } from "../lib/layout";

  let { k, interactive = true }: { k: number; interactive?: boolean } = $props();

  type Box = [x0: number, x1: number, y0: number, y1: number, z0: number, z1: number]; // y relative to the lane or belt
  const y0 = $derived(laneY0(k));
  const cy = $derived(beltCy(k));
  const hh = BELT_W / 2;

  // Bounding boxes in world units, measured from the same constants Lane.svelte builds with.
  const stations = $derived.by<{ stage: string; label: string; box: Box }[]>(() => [
    { stage: "pick", label: "pick", box: [1.0, 4.9, y0 + 5.0, y0 + 7.6, 0.3, 3.3] },        // turnstile
    { stage: "plan", label: "plan", box: [6.9, 11.1, y0 + 0.3, y0 + 3.1, 0.3, 3.2] },       // drafting table
    { stage: "build", label: "build", box: [14.7, 18.1, y0 + 1.8, y0 + 7.6, 0.3, 7.2] },    // press + wheel
    { stage: "verify", label: "verify", box: [20.2, 23.8, cy - 1.8, cy + 1.8, 0.3, 1.7] },  // quench bath
    { stage: "review", label: "review", box: [26.3, 30.7, y0 + 3.7, y0 + 7.6, 0.3, 3.9] },  // loupe arm
    { stage: "pr", label: "pr", box: [32.5, 34.5, cy - hh - 0.5, cy + hh + 0.5, 0.3, 5.0] }, // ropeway pylon
    { stage: "ci", label: "ci", box: [39.4, 41.7, y0 + 0.3, y0 + 2.4, 0.3, 7.0] },          // signal tower
  ]);

  const shapes = $derived(
    stations.map((s) => {
      const [x0, x1, ya, yb, z0, z1] = s.box;
      const pts: [number, number][] = [];
      for (const x of [x0, x1]) for (const y of [ya, yb]) for (const z of [z0, z1]) pts.push(project(x, y, z) as [number, number]);
      return { ...s, d: "M" + hull(pts).map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L") + "Z" };
    }),
  );

  let hover = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let down: { x: number; y: number; id: number; stage: string; el: Element } | null = null;

  function open(stage: string, el?: Element | null) {
    clearTimeout(timer);
    timer = undefined;
    (el as SVGElement | null)?.focus?.({ preventScroll: true });
    ui.inspect = { k: k + 1, stage };
  }
  function cancelTap() {
    down = null;
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", cancelTap, true);
  }
  function onUp(e: PointerEvent) {
    const d = down;
    if (!d || e.pointerId !== d.id) return;
    cancelTap();
    if (e.button !== 0 || !isTap(d, { x: e.clientX, y: e.clientY })) return;
    // double-click flies the camera instead: wait one beat, a second press cancels the open
    timer = setTimeout(() => open(d.stage, d.el), 240);
  }
  function onDown(e: PointerEvent, stage: string) {
    if (!interactive || e.button !== 0) return;
    if (timer) { clearTimeout(timer); timer = undefined; return; } // second press of a double-click
    cancelTap();
    down = { x: e.clientX, y: e.clientY, id: e.pointerId, stage, el: e.currentTarget as Element };
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", cancelTap, true);
  }
  function onKey(e: KeyboardEvent, stage: string) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(stage); }
  }
  onDestroy(() => { clearTimeout(timer); cancelTap(); });
</script>

{#if interactive}
  <g class="stationhits" data-hits={`lane-${k + 1}`}>
    {#each shapes as s (s.stage)}
      <path
        class="sthit" class:on={hover === s.stage}
        d={s.d}
        role="button" tabindex="0"
        aria-label={`Inspect lane ${k + 1} · ${s.label}`}
        data-station={s.stage}
        onpointerenter={() => (hover = s.stage)}
        onpointerleave={() => (hover = hover === s.stage ? null : hover)}
        onfocus={(e) => { if (e.currentTarget.matches(":focus-visible")) hover = s.stage; }}
        onblur={() => (hover = hover === s.stage ? null : hover)}
        onpointerdown={(e) => onDown(e, s.stage)}
        onkeydown={(e) => onKey(e, s.stage)}
      />
    {/each}
  </g>
{/if}

<style>
  .sthit { fill: transparent; stroke: none; cursor: pointer; outline: none; pointer-events: all; stroke-linejoin: round; }
  .sthit.on { stroke: var(--text-dim); stroke-width: 1; vector-effect: non-scaling-stroke; fill: color-mix(in srgb, var(--top) 5%, transparent); }
  .sthit:focus-visible { stroke: var(--text); stroke-width: 1.4; stroke-dasharray: none; vector-effect: non-scaling-stroke; }
</style>
