<script lang="ts">
  // The Foundry as one SVG. mode "full": all three lanes, rack, cabinet, stack (desktop).
  // mode "lane": a single lane plus the stack (mobile, one lane per screen).
  // The camera (pan, zoom, fly-to, follow) only ever rewrites this element's viewBox.
  import Lane from "./Lane.svelte";
  import Stack from "./Stack.svelte";
  import Cabinet from "./Cabinet.svelte";
  import Rack from "./Rack.svelte";
  import { project, pathOf, unproject } from "../lib/iso";
  import { STATION_X, beltCy, laneBox, machineBox, stackTop } from "../lib/layout";
  import { settle } from "../lib/anim.svelte";
  import { cam, flyTo, panPixels, register, zoomAt } from "../lib/camera.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { vp } from "../lib/viewport.svelte";
  import type { Box } from "../lib/camera.svelte";

  let { mode = "full", k = 0, interactive = true }: { mode?: "full" | "lane"; k?: number; interactive?: boolean } = $props();

  let svg = $state<SVGSVGElement>();
  const base = $derived<Box>(mode === "full" ? machineBox() : laneBox(k));

  // faint isometric floor grid, one path
  const grid = (() => {
    let d = "";
    for (let y = -8; y <= 34; y += 2) d += pathOf([project(-18, y, 0), project(62, y, 0)], false);
    for (let x = -18; x <= 62; x += 2) d += pathOf([project(x, -8, 0), project(x, 34, 0)], false);
    return d;
  })();

  $effect(() => {
    void store.snap;
    void store.strokes;
    settle();
  });

  // ---------------------------------------------------------------- camera wiring
  $effect(() => {
    const el = svg;
    if (!el) return;
    const b = base;
    return register({ el, base: () => b });
  });

  const ptrs = new Map<number, { x: number; y: number }>();
  let dragging = $state(false);
  let pinchD = 0;

  const isControl = (t: EventTarget | null): boolean => t instanceof Element && t.closest(".hit") != null;
  const canPan1 = (e: PointerEvent): boolean => e.pointerType !== "touch" || !vp.mobile; // phone: one finger swipes lanes, two pan

  function down(e: PointerEvent) {
    if (!svg || isControl(e.target)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinchD = Math.hypot(a.x - b.x, a.y - b.y);
      for (const id of ptrs.keys()) svg.setPointerCapture(id);
      dragging = true;
    } else if (canPan1(e)) {
      svg.setPointerCapture(e.pointerId);
      dragging = true;
    }
  }
  function move(e: PointerEvent) {
    const p = ptrs.get(e.pointerId);
    if (!svg || !p) return;
    if (ptrs.size === 2) {
      const before = [...ptrs.values()];
      const mx0 = (before[0].x + before[1].x) / 2, my0 = (before[0].y + before[1].y) / 2;
      p.x = e.clientX; p.y = e.clientY;
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      panPixels(svg, base, mx - mx0, my - my0);
      if (pinchD > 0 && d > 0) zoomAt(svg, base, d / pinchD, mx, my, true);
      pinchD = d;
    } else if (dragging) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      panPixels(svg, base, dx, dy);
    }
  }
  function up(e: PointerEvent) {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinchD = 0;
    if (ptrs.size === 0) dragging = false;
  }

  // wheel and touch listeners must be non-passive to be able to prevent page scroll / browser zoom
  $effect(() => {
    const el = svg;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(el, base, Math.exp(-px * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX, e.clientY);
    };
    const touch = (e: TouchEvent) => { if (e.touches.length >= 2) e.preventDefault(); };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("touchmove", touch, { passive: false });
    return () => { el.removeEventListener("wheel", wheel); el.removeEventListener("touchmove", touch); };
  });

  /** Double-click a station: fly there and flash its margin readout. */
  function dbl(e: MouseEvent) {
    if (mode !== "full" || !svg || isControl(e.target)) return;
    const m = svg.getScreenCTM();
    if (!m) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const u = pt.matrixTransform(m.inverse());
    const w = unproject(u.x, u.y, 1);
    let lane = Math.floor((w.y + 0.5) / 10);
    const inStack = w.x > 45.5 && w.x < 55 && w.y > 10 && w.y < 18;
    if (inStack) {
      lane = 1;
      const top = stackTop(store.snap.metrics?.merged_7d ?? 0);
      const [ux, uy] = project(50.5, 14, top + 1);
      flyTo(ux, uy, 3.4);
    } else {
      if (lane < 0 || lane > 2 || w.x < -4 || w.x > 45) return;
      const xs = [STATION_X.pick, STATION_X.plan, STATION_X.build, STATION_X.verify, STATION_X.review, STATION_X.pr, STATION_X.ci];
      const sx = xs.reduce((a, b) => (Math.abs(b - w.x) < Math.abs(a - w.x) ? b : a));
      const [ux, uy] = project(sx, beltCy(lane), 1.6);
      flyTo(ux, uy, 3.4);
    }
    ui.flash(lane);
  }
</script>

<svg
  bind:this={svg}
  class="machine"
  class:grab={!vp.mobile || mode === "full"}
  class:grabbing={dragging}
  class:phone={vp.mobile}
  preserveAspectRatio="xMidYMid meet"
  role="group"
  aria-label={mode === "full" ? "Foundry: three production lanes. Drag to pan, wheel to zoom, double-click a station to fly to it." : `Lane ${k + 1}`}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={dbl}
>
  <defs>
    <radialGradient id="g-acc" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="var(--accent)" stop-opacity="0.95" />
      <stop offset="0.55" stop-color="var(--accent)" stop-opacity="0.38" />
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
    </radialGradient>
  </defs>
  <path d={grid} class="grid" />
  {#if mode === "full"}
    <Rack />
    <Cabinet />
    <Lane k={0} {interactive} />
    <Lane k={1} {interactive} />
    <Lane k={2} {interactive} />
    <Stack />
  {:else}
    <Lane {k} {interactive} />
    <Stack only={k} />
  {/if}
</svg>

<style>
  .machine { display: block; width: 100%; height: auto; overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; }
  .machine.phone { touch-action: pan-x pan-y; }
  .machine.grab { cursor: grab; }
  .machine.grabbing { cursor: grabbing; }
  .grid { fill: none; stroke: var(--grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
</style>
