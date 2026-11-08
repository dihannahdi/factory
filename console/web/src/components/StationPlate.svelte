<script lang="ts">
  // The "now doing" tag: a thin machined plate lying flat on the lane bed, in the strip between the
  // belt and the hand controls, next to the station that is working. It prints the newest command /
  // file / sentence the agent produced, flips to it split-flap style, and says "thinking · 12s" when
  // the model has been silent. Lying on the bed it never covers a station, the work item or another
  // lane; it only ever sits under things that stand in front of it. It speaks in the neutral ramp;
  // the only accent is the pilot dot at its end (an agent is here).
  import Faces from "./Faces.svelte";
  import { anim } from "../lib/anim.svelte";
  import { store } from "../lib/store.svelte";
  import { laneVM } from "../lib/lanes";
  import { box, disc, line3, plate, project, topMatrix } from "../lib/iso";
  import { STATION_X, laneY0 } from "../lib/layout";
  import { PLATE_COLS, fitCols, flapFrame, plateLabel } from "../lib/plate";
  import type { Stage } from "../lib/types";

  let { k }: { k: number } = $props();

  const vm = $derived(laneVM(store.snap.slots[k], store.now));
  const show = $derived(vm.working && vm.stage != null && !vm.dormant);

  // ---------------------------------------------------------------- where it lies (world units)
  const FS = 0.56; // font size; the engraved stage names use 0.72
  const ADV = FS * 0.6; // mono advance
  const PADL = 0.7, PADR = 0.7; // room for the screw and the pilot dot
  // The strip runs from just past the belt (y0 + 5.1) and the quench tank's near wall (5.3) to just
  // short of the e-stop, speaking tube and review post (6.38). Along x it is cut where a part stands
  // in it or in front of it (turnstile foot to 4.5, press posts 13.8-16.9, review post 25.8-28.9),
  // because the tag is painted after those parts and would otherwise lie on top of them.
  const SY0 = 5.4, D = 0.92, Z0 = 0.3, TH = 0.12;
  const A: [number, number] = [4.6, 13.7], B: [number, number] = [17.0, 25.7], C: [number, number] = [29.0, 44.7];
  const segOf = (st: Stage): [number, number] => (st === "pick" || st === "plan" ? A : st === "build" || st === "verify" ? B : C);
  const late = (st: Stage): boolean => st === "merge" || st === "deploy" || st === "live";

  // ---------------------------------------------------------------- what it says
  const lab = $derived.by(() => {
    void store.now; // the thinking / wait counters tick once a second
    const slot = vm.slot;
    const items = store.snap.activity[String(k + 1)] ?? [];
    let silence: number | null = null;
    if (slot.turn) {
      // server clock throughout: arrival time of the last event, newest item, turn start - whichever is latest
      const offMs = store.nowF() * 1000 - Date.now();
      const le = store.lastEvent[k];
      let base = slot.turn.started * 1000;
      if (le > 0) base = Math.max(base, le + offMs);
      for (let i = items.length - 1; i >= 0 && i >= items.length - 3; i--) base = Math.max(base, items[i].t);
      silence = Math.max(0, store.nowF() - base / 1000);
    }
    return plateLabel({
      stage: slot.stage ?? "",
      sub: slot.sub,
      turn: slot.turn != null,
      items,
      silence,
      checks: slot.ci?.checks.length ?? null,
      elapsed: slot.stage_started != null ? store.nowF() - slot.stage_started : null,
    });
  });

  const seg = $derived(segOf((vm.stage ?? "pick") as Stage));
  const cap = $derived(Math.min(PLATE_COLS, Math.floor((seg[1] - seg[0] - PADL - PADR) / ADV)));
  const text = $derived(fitCols(lab.text, cap));

  // split-flap: runs ~250 ms from the animation clock when the *kind* of line changes. Plain
  // variables, not state: only the derived reads them.
  const FLIP_S = 0.25;
  let fKey = "";
  let fT0 = 0;
  let fOn = false;
  const shown = $derived.by(() => {
    const L = lab;
    if (anim.reduced) { fKey = L.key; fOn = false; return text; }
    if (L.key !== fKey) { fKey = L.key; fT0 = anim.t; fOn = true; }
    if (!fOn) return text;
    const p = (anim.t - fT0) / FLIP_S; // reads the clock only while flipping
    if (p >= 1) { fOn = false; return text; }
    return flapFrame(text, p, Math.floor(anim.t * 30));
  });
  const thinking = $derived(lab.key === "thinking");

  // ---------------------------------------------------------------- shape, relative to its far-left corner
  // As long as its line (at least 8 columns). It starts under the station's engraved name when there
  // is room and slides left just enough to stay inside its strip; on the shared stack it lies at the
  // lane's end, right-aligned. Projection is linear, so the faces are built at the origin and the
  // group is translated: the move between stations is then one CSS transition.
  const W = $derived(Math.max(8, text.length) * ADV + PADL + PADR);
  const x0 = $derived.by(() => {
    const st = (vm.stage ?? "pick") as Stage;
    if (late(st)) return seg[1] - W;
    return Math.min(Math.max(STATION_X[st] - 1.2, seg[0]), seg[1] - W);
  });
  const at = $derived(project(x0, laneY0(k) + SY0, 0));
  const ZT = Z0 + TH;
  const slab = $derived(box(0, 0, Z0, W, D, TH, { top: "s1", left: "s2", right: "s3" }));
  const lip = $derived(plate(0.12, 0.1, ZT, W - 0.24, D - 0.2).d);
  const screw = disc(0.36, D / 2, ZT, 0.15, "s3").d;
  const nick = line3([[0.27, D / 2 + 0.06, ZT], [0.45, D / 2 - 0.06, ZT]]);
  const pilot = $derived(disc(W - 0.36, D / 2, ZT, 0.17).d);
  const textAt = topMatrix(PADL, D / 2 + FS * 0.36, ZT);
</script>

{#if show}
  <g class="plate" class:still={anim.reduced} style="transform: translate({at[0]}px, {at[1]}px)" data-part={`plate-${k + 1}`} aria-hidden="true">
    <Faces faces={slab} />
    <path d={lip} class="lip" />
    <path d={screw} class="screw" />
    <path d={nick} class="slot" />
    <path d={pilot} class="pilot" class:think={thinking} />
    <text transform={textAt} class="cut" font-size={FS} textLength={shown.length * ADV} lengthAdjust="spacing">{shown}</text>
  </g>
{/if}

<style>
  .plate { transition: transform 0.55s cubic-bezier(0.3, 0.8, 0.25, 1); animation: rise 0.35s ease-out both; pointer-events: none; }
  .plate.still { transition: none; animation: none; }
  .lip { fill: none; stroke: var(--line); stroke-width: 0.7; vector-effect: non-scaling-stroke; opacity: 0.3; }
  .screw { fill: var(--shade-3); stroke: var(--line); stroke-width: 0.7; vector-effect: non-scaling-stroke; }
  .slot { fill: none; stroke: var(--line); stroke-width: 0.8; vector-effect: non-scaling-stroke; }
  .pilot { fill: var(--accent); stroke: var(--line); stroke-width: 0.7; vector-effect: non-scaling-stroke; }
  .pilot.think { animation: blink 1.4s ease-in-out infinite; }
  .cut { fill: var(--line); font-family: ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-weight: 600; white-space: pre; letter-spacing: 0; }
  @keyframes rise { from { opacity: 0; } to { opacity: 1; } }
  @keyframes blink { 50% { opacity: 0.25; } }
</style>
