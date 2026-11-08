<script lang="ts">
  // One production line: floor, belt, seven stations, the work item riding them, and the lane's two
  // hand controls (e-stop mushroom, speaking tube). Everything is built from the iso toolkit; the
  // only inputs are the store and the animation poses derived from it.
  import Faces from "./Faces.svelte";
  import WorkItem from "./WorkItem.svelte";
  import ActionLayer from "./ActionLayer.svelte";
  import StationPlate from "./StationPlate.svelte";
  import StationHits from "./StationHits.svelte";
  import { box, cylV, cylAxis, rotBox, plate, disc, discXZ, gearXZ, ringArc, line3, project, topMatrix, ring, capPoint, sortByDepth } from "../lib/iso";
  import type { Face } from "../lib/iso";
  import { anim, lanes } from "../lib/anim.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { laneVM } from "../lib/lanes";
  import { BELT_TOP, BELT_W, BELT_Y, CABLE_Z, LANE_W, STATION_X, beltCy, cableA, cableB, laneY0, padY, stackTop, stageProgress } from "../lib/layout";
  
  let { k, interactive = true }: { k: number; interactive?: boolean } = $props();

  const y0 = $derived(laneY0(k));
  const cy = $derived(beltCy(k));
  const vm = $derived(laneVM(store.snap.slots[k], store.now));
  const A = $derived(lanes[k]);
  const stage = $derived(vm.working ? vm.stage : null);
  const accOr = (s: string) => (stage === s ? ("acc" as const) : ("top" as const));
  const ro = $derived(store.snap.readonly);
  const top = $derived(stackTop(store.snap.metrics?.merged_7d ?? 0));
  const dim = $derived(vm.dormant ? 0.3 : ui.hoverLane != null && ui.hoverLane !== k ? 0.5 : 1);

  // ---------------------------------------------------------------- static bed
  const bed = $derived<Face[]>([
    ...box(-4.5, y0, 0, 49.5, LANE_W, 0.3, { top: "s4", left: "s3", right: "s4" }),
    ...box(-3.5, y0 + BELT_Y, 0.3, 37.2, BELT_W, BELT_TOP - 0.3, { top: "s3", left: "s2", right: "s3" }),
  ]);
  const slats = $derived.by(() => {
    const off = A.belt % 1;
    let d = "";
    for (let x = -3.4 + off; x < 33.4; x += 1) d += line3([[x, y0 + BELT_Y + 0.2, BELT_TOP], [x, y0 + BELT_Y + BELT_W - 0.2, BELT_TOP]]);
    return d;
  });

  // glow plate under the active station (accent: an agent is here)
  const glowX = $derived(stage && stage !== "merge" && stage !== "deploy" && stage !== "live" ? STATION_X[stage] : null);
  const glow = $derived(glowX == null ? "" : plate(glowX - 3.6, y0 + 0.3, 0.31, 7.2, LANE_W - 0.6).d);

  // ---------------------------------------------------------------- pick: turnstile + waiting ingots
  const gatePost = $derived<Face[]>([
    ...box(1.6, y0 + 5.2, 0.3, 2.8, 2.2, 0.22, { top: "s3", left: "s2", right: "s3" }),
    ...cylV(3, y0 + 6.3, 0.52, 0.36, 2.7),
  ]);
  const gate = $derived.by(() => {
    const a0 = A.gate;
    const arms = [0, 1, 2].map((i) => {
      const a = a0 + i * 2.0944;
      const cx = 3 + Math.cos(a) * 1.25, cyy = y0 + 6.3 + Math.sin(a) * 1.25;
      return { depth: cx + cyy, faces: rotBox(cx, cyy, 2.5, 2.5, 0.24, 0.24, a) };
    });
    return [...sortByDepth(arms).flatMap((a) => a.faces), disc(3, y0 + 6.3, 3.22, 0.5, accOr("pick"))];
  });
  const waiting = $derived.by(() => {
    if (vm.dormant) return [] as { f: Face[]; queued: boolean }[];
    const list = (store.snap.github?.issues ?? []).filter((i) => i.class === "queued" || i.class === "eligible").sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    const mine = [list[k], list[k + 3], list[k + 6]].filter((x) => x != null);
    return mine.map((i, n) => ({ queued: i.class === "queued", f: box(-3.2 + n * 1.45, y0 + BELT_Y + 0.5, BELT_TOP, 1.15, 1.2, 0.55, { top: i.class === "queued" ? "top" : "s1" }) }));
  });

  // ---------------------------------------------------------------- plan: drafting table, unrolling sheet
  const table = $derived<Face[]>([
    ...box(7.3, y0 + 0.5, 0.3, 0.3, 0.3, 1.4, { top: "s3" }),
    ...box(10.5, y0 + 0.5, 0.3, 0.3, 0.3, 1.4, { top: "s3" }),
    ...box(7.3, y0 + 2.2, 0.3, 0.3, 0.3, 1.4, { top: "s3" }),
    ...box(10.5, y0 + 2.2, 0.3, 0.3, 0.3, 1.4, { top: "s3" }),
    ...box(7.0, y0 + 0.3, 1.7, 4.0, 2.4, 0.25, { top: "s1", left: "s2", right: "s3" }),
  ]);
  const unroll = $derived.by(() => {
    const idx = vm.stageIdx;
    if (idx < 0 || idx < 1) return 0.12;
    if (idx > 1) return 1;
    const med = (store.snap.metrics?.stage_median_min?.plan ?? 3) * 60;
    return 0.12 + 0.88 * Math.min(0.95, (vm.elapsed ?? 0) / Math.max(30, med));
  });
  const sheet = $derived.by(() => {
    const len = 3.0 * unroll;
    const s = [...cylAxis("y", 7.5, y0 + 0.55, 2.2, 1.9, 0.26, 10, "s1")];
    if (len > 0.5) s.push(plate(7.5 + 0.1, y0 + 0.55, 1.96, Math.min(len, 3.0), 1.9, "top"));
    return s;
  });
  const ticks = $derived.by(() => {
    const req = vm.slot.requirements;
    if (!req || req.total < 1 || unroll < 0.5) return { on: "", off: "" };
    const n = Math.min(req.total, 24);
    let on = "", off = "";
    for (let i = 0; i < n; i++) {
      const x = 8.0 + (i + 0.5) * (2.6 / n);
      const seg = line3([[x, y0 + 0.8, 1.97], [x, y0 + 1.3 + (i < req.done ? 0.9 : 0.35), 1.97]]);
      if (i < req.done) on += seg; else off += seg;
    }
    return { on, off };
  });

  // ---------------------------------------------------------------- build: stamping press (+ counter wheel)
  const pressBack = $derived<Face[]>([
    ...box(14.9, y0 + 1.9, 0.3, 1.3, 0.9, 6.0, { top: "s1" }),
    ...box(14.9, y0 + 1.9, 6.3, 1.3, 4.6, 0.8, { top: "s1" }),
  ]);
  const pressFront = $derived<Face[]>([
    ...box(14.9, y0 + 5.6, 0.3, 1.3, 0.9, 6.0, { top: "s1" }),
    ...box(14.9, y0 + 5.6, 6.3, 1.3, 0.9, 0.8, { top: "s1" }),
  ]);
  // The ram strikes the ingot's top face: at full stroke its underside sits exactly on INGOT_TOP
  // (belt + the ingot's 0.8 height, WorkItem.svelte), straight above the ingot's centre
  // (itemPose("build") = x 15.5 on the belt centre line). It used to stop 0.3 short, and in an
  // isometric view a blow that ends in the air reads as one landing beside the package.
  const INGOT_TOP = BELT_TOP + 0.8;
  const RAM_REST = 4.3;
  const RAM_X = 15.5, RAM_HALF = 0.6;
  const ram = $derived.by(() => {
    const z = Math.max(INGOT_TOP, RAM_REST - A.press * (RAM_REST - INGOT_TOP) - A.osc * 0.25);
    return [...cylV(RAM_X, cy, z + 1.0, 0.2, 6.3 - z - 1.0), ...box(RAM_X - RAM_HALF, cy - RAM_HALF, z, 2 * RAM_HALF, 2 * RAM_HALF, 1.0, { top: accOr("build") })];
  });
  // the ingot is under the ram (build stage, item arrived): show where the blow lands
  const underRam = $derived(vm.hasIssue && stage === "build" && Math.abs(A.x - RAM_X) < 0.6 && A.z <= BELT_TOP + 0.05);
  const contact = $derived(underRam ? plate(RAM_X - RAM_HALF, cy - RAM_HALF, INGOT_TOP + 0.01, 2 * RAM_HALF, 2 * RAM_HALF).d : "");
  const contactO = $derived(0.12 + 0.5 * A.press);
  // sparks fly out of the four corners of the contact square, on the ingot's top face
  const impact = $derived(underRam && A.press > 0.85
    ? [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => line3([
        [RAM_X + sx * RAM_HALF, cy + sy * RAM_HALF, INGOT_TOP + 0.04],
        [RAM_X + sx * (RAM_HALF + 0.7), cy + sy * (RAM_HALF + 0.45), INGOT_TOP + 0.4],
      ])).join("")
    : "");
  const wheel = $derived.by(() => {
    const c = vm.complete;
    const f = cylAxis("y", 15.55, y0 + 6.5, 4.4, 0.45, 0.8, 14, "s2");
    const dots: { p: [number, number]; on: boolean }[] = [];
    const n = c?.of ?? 4;
    for (let i = 0; i < n; i++) dots.push({ p: capPoint("y", 15.55, y0 + 6.5, 4.4, 0.45, 0.5, -Math.PI / 2 + (i * 2 * Math.PI) / n), on: c != null && i < c.r });
    return { f, dots };
  });

  // ---------------------------------------------------------------- verify: quench bath
  // A hollow tank, sized for the ingot (3.5 x 1.8, itemPose("verify") = x 22 on the belt centre,
  // bottom at BELT_TOP - 0.45, top 0.8 higher). Back walls and floor are painted before the
  // ingot, the liquid and the front walls after it, so the ingot reads as dipped. The old
  // "bath" was a solid 3.4 block with a 2.5 liquid plate drawn across a 3.5 ingot that stood
  // out of it.
  const TANK = { x: 20.0, w: 4.0, d: 2.6, wall: 0.18, z: 0.3, h: 1.3 } as const;
  const LIQUID_Z = BELT_TOP - 0.45 + 0.8 + 0.07; // just over the dipped ingot's top face
  const bathBack = $derived.by<Face[]>(() => {
    const y = cy - TANK.d / 2;
    return [
      ...box(TANK.x, y, TANK.z, TANK.w, TANK.d, 0.12, { top: "s4", left: "s3", right: "s4" }), // floor
      ...box(TANK.x, y, TANK.z, TANK.wall, TANK.d, TANK.h, { top: "s1", left: "s2", right: "s3" }), // far x wall
      ...box(TANK.x, y, TANK.z, TANK.w, TANK.wall, TANK.h, { top: "s1", left: "s2", right: "s3" }), // far y wall
    ];
  });
  const liquid = $derived.by(() => {
    const flick = vm.verifyFailing && A.flick > 0.4;
    return { d: plate(TANK.x + TANK.wall, cy - TANK.d / 2 + TANK.wall, LIQUID_Z, TANK.w - 2 * TANK.wall, TANK.d - 2 * TANK.wall).d, flick };
  });
  const bathFront = $derived.by<Face[]>(() => {
    const y = cy - TANK.d / 2;
    return [
      ...box(TANK.x + TANK.w - TANK.wall, y, TANK.z, TANK.wall, TANK.d, TANK.h, { top: "s1", left: "s2", right: "s3" }), // near x wall
      ...box(TANK.x, y + TANK.d - TANK.wall, TANK.z, TANK.w, TANK.wall, TANK.h, { top: "s1", left: "s2", right: "s3" }), // near y wall
    ];
  });
  const bubbles = $derived.by(() => {
    const run = vm.working && vm.stage === "verify";
    if (!run && !(vm.working && !anim.reduced)) return [] as { x: number; y: number; r: number; o: number }[];
    const n = run ? 7 : 2;
    const out = [];
    for (let i = 0; i < n; i++) {
      const ph = (A.verifyAt * (0.5 + (i % 3) * 0.17) + i * 0.37) % 1;
      const [sx, sy] = project(TANK.x + 0.5 + ((i * 0.83) % 3.0), cy - 0.9 + ((i * 1.37) % 1.8), LIQUID_Z + ph * 1.6);
      out.push({ x: sx, y: sy, r: 1.3 + (i % 3) * 0.6, o: 1 - ph });
    }
    return out;
  });
  // a failing verify cracks the tank's near x wall
  const crack = $derived(vm.verifyFailing ? (() => { const wx = TANK.x + TANK.w; return line3([[wx, cy - 1.0, 0.5], [wx, cy - 0.5, 0.95], [wx, cy - 0.1, 0.7], [wx, cy + 0.5, 1.2], [wx, cy + 1.1, 0.8]]); })() : "");

  // ---------------------------------------------------------------- review: second arm with a loupe
  const review = $derived.by(() => {
    const working = vm.working && vm.stage === "review";
    const ang = -Math.PI / 2 + (working ? Math.sin(anim.t * 1.1) * 0.32 : 0.95);
    const px = 28.5, py = y0 + 7.0, len = 3.0;
    const ex = px + Math.cos(ang) * len, ey = py + Math.sin(ang) * len;
    return {
      base: [...cylV(px, py, 0.3, 0.55, 0.5), ...cylV(px, py, 0.8, 0.22, 2.7)],
      arm: [...cylV(px, py, 3.5, 0.34, 0.3, 10, { top: accOr("review") }), ...rotBox((px + ex) / 2, (py + ey) / 2, 3.45, len, 0.28, 0.28, ang)],
      lens: ring(ex, ey, 3.5, 0.95) + ring(ex, ey, 3.5, 0.62),
      handle: line3([[ex, ey, 3.5], [ex + Math.cos(ang) * 0.9, ey + Math.sin(ang) * 0.9, 3.5]]),
    };
  });

  // ---------------------------------------------------------------- pr / ci: ropeway + signal tower
  const cablePath = $derived(line3([cableA(k), cableB(k, top)]));
  const pylons = $derived<Face[]>([
    ...box(33.2, cy - 0.25, 0.3, 0.5, 0.5, CABLE_Z - 0.15, { top: "s1" }),
  ]);
  const pylonB = $derived<Face[]>([...box(45.95, padY(k) - 0.25, 0, 0.5, 0.5, top + 2.4, { top: "s1" })]);
  const tower = $derived<Face[]>([
    ...box(39.9, y0 + 0.7, 0.3, 1.3, 1.3, 6.2, { top: "s1", left: "s2", right: "s3" }),
    ...box(39.7, y0 + 0.5, 6.5, 1.7, 1.7, 0.35, { top: accOr("ci"), left: "s1", right: "s2" }),
  ]);
  const lampCount = $derived(Math.max(3, vm.lamps.length));
  const lamps = $derived.by(() => {
    const out: { f: Face[]; state: string; x: number; y: number; cross: string }[] = [];
    for (let i = 0; i < lampCount; i++) {
      const st = vm.lamps[i] ?? "off";
      const z = 1.4 + i * (4.6 / Math.max(2, lampCount - 1)) * (lampCount > 4 ? 1 : 0.85);
      const pulse = st === "run" ? (anim.reduced ? 1 : 0.5 + 0.5 * Math.sin(anim.t * 5 + i)) : 1;
      const slow = anim.reduced ? 1 : Math.sin(anim.t * 2.4 + i * 1.3);
      const tone = st === "ok" ? "top" : st === "run" ? (pulse > 0.5 ? "top" : "s1") : st === "wait" ? (slow > 0.2 ? "s1" : "s2") : "s4";
      const cx = 40.55, yy = y0 + 2.0 + 0.01;
      const [px, py] = project(cx, yy, z);
      const c = st === "fail" ? line3([[cx - 0.22, yy, z - 0.22], [cx + 0.22, yy, z + 0.22]]) + line3([[cx - 0.22, yy, z + 0.22], [cx + 0.22, yy, z - 0.22]]) : "";
      out.push({ f: [discXZ(cx, yy, z, 0.34, tone as Face["tone"], 14)], state: st, x: px, y: py, cross: c });
    }
    return out;
  });

  // ---------------------------------------------------------------- continuous life
  const gearOn = (s: string) => vm.working && vm.stage === s;
  const gears = $derived<Face[]>([
    gearXZ(8.0, y0 + 2.74, 1.0, 0.8, 9, gearOn("plan") ? A.gear : 0.3, "s1"),
    discXZ(8.0, y0 + 2.75, 1.0, 0.22, "s4", 10),
    gearXZ(17.5, y0 + 6.52, 2.1, 0.72, 9, gearOn("build") ? -A.gear : 0.3, "s1"),
    discXZ(17.5, y0 + 6.53, 2.1, 0.2, "s4", 10),
  ]);
  const pen = $derived.by(() => {
    if (!(vm.working && vm.stage === "plan")) return null;
    const len = Math.max(0.6, 3.0 * unroll - 0.3);
    const at = (t: number): [number, number, number] => [7.7 + (0.5 + 0.5 * Math.sin(t * 0.9)) * len, y0 + 0.75 + (0.5 + 0.5 * Math.sin(t * 3.1 + 1)) * 1.1, 1.98];
    const tip = at(anim.t);
    const trail: [number, number, number][] = [];
    for (let j = 14; j >= 0; j--) trail.push(at(anim.t - j * 0.05));
    return { trail: line3(trail), body: line3([tip, [tip[0] + 0.35, tip[1] - 0.2, 2.9]]) };
  });
  // progress ring: how far through the stage's typical duration, pulsing once overdue
  const prog = $derived.by(() => {
    if (!vm.working || !vm.stage || vm.stage === "merge" || vm.stage === "deploy" || vm.stage === "live") return null;
    void anim.t;
    const el = vm.slot.stage_started != null ? store.nowF() - vm.slot.stage_started : null;
    const p = stageProgress(el, store.snap.metrics?.stage_median_min, vm.stage);
    const x = STATION_X[vm.stage];
    const over = p >= 1;
    return { arc: ringArc(x, cy, 0.34, 3.05, Math.min(1, p)), base: ringArc(x, cy, 0.34, 3.05, 1), over, pulse: over ? (anim.reduced ? 1 : 0.55 + 0.45 * Math.sin(anim.t * 2.2)) : 1 };
  });
  const sparks = $derived.by(() => {
    if (!vm.working || anim.reduced) return [] as { x: number; y: number; r: number; o: number }[];
    const out: { x: number; y: number; r: number; o: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const bx = ((A.belt * 0.9 + i * 5.3) % 37) - 3;
      const [sx, sy] = project(bx, cy + Math.sin(i * 7.1) * 0.75, BELT_TOP + 0.12);
      out.push({ x: sx, y: sy, r: 0.9, o: 0.55 });
    }
    const st = vm.stage;
    if (st && st !== "merge" && st !== "deploy" && st !== "live") {
      for (let i = 0; i < 5; i++) {
        const ph = (A.spark * 0.7 + i * 0.2) % 1;
        const [sx, sy] = project(STATION_X[st] + (i - 2) * 0.45 + Math.sin(i * 3.3 + A.spark) * 0.2, cy + (i % 2 ? 0.5 : -0.5), BELT_TOP + 0.6 + ph * 2.6);
        out.push({ x: sx, y: sy, r: 1.1 * (1 - ph * 0.6), o: 0.85 * (1 - ph) });
      }
    }
    return out;
  });

  // engraved stage names on the floor edge
  const names: { x: number; t: string }[] = [
    { x: 3, t: "pick" }, { x: 9, t: "plan" }, { x: 15.5, t: "build" }, { x: 22, t: "verify" }, { x: 28.5, t: "review" }, { x: 34.5, t: "pr" }, { x: 40.5, t: "ci" },
  ];

  // ---------------------------------------------------------------- hand controls
  const estopOk = $derived(vm.canInterrupt && !ro);
  const pressed = $derived(vm.deferred || vm.slot.state === "stopping");
  const ex = 5.6, tubeX = 7.8;
  const estop = $derived<Face[]>([
    ...cylV(ex, y0 + 7.0, 0.3, 0.62, 0.45, 12, { top: "s3" }),
    ...cylV(ex, y0 + 7.0, 0.75, 0.2, 0.45, 8),
    ...cylV(ex, y0 + 7.0, pressed ? 1.05 : 1.25, 0.58, 0.38, 14, { top: estopOk ? "top" : "s2" }),
  ]);
  const estopHit = $derived(project(ex, y0 + 7.0, 1.2));
  const tube = $derived<Face[]>([
    ...cylV(tubeX, y0 + 7.0, 0.3, 0.5, 0.35, 10, { top: "s3" }),
    ...cylV(tubeX, y0 + 7.0, 0.65, 0.17, 1.35, 8),
    ...cylV(tubeX, y0 + 7.0, 2.0, 0.55, 0.5, 12, { top: "s4" }),
  ]);
  const tubeHit = $derived(project(tubeX, y0 + 7.0, 1.6));
  const steerGlow = $derived(vm.steer?.state === "pending");

  function openStop() {
    if (!interactive || !estopOk) return;
    ui.sheet = { kind: "stop", k: k + 1 };
  }
  function openSteer() {
    if (!interactive || ro || !vm.canInterrupt) return;
    ui.sheet = { kind: "steer", k: k + 1 };
  }
  const key = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
  };
</script>

<g class="lane" opacity={dim} data-lane={k + 1}>
  <Faces faces={bed} />
  {#if glow}<path d={glow} class="glow" />{/if}
  <path d={slats} class="slat" data-part={`belt-${k + 1}`} />
  {#if prog}<path d={prog.base} class="ring" /><path d={prog.arc} class="arc" opacity={prog.pulse} />{/if}

  {#each names as n (n.t)}
    <text class="eng" class:on={stage === n.t} transform={topMatrix(n.x - 1.2, y0 + LANE_W - 0.25, 0.31)} font-size="0.72">{n.t}</text>
  {/each}

  <!-- pick: the waiting ingots sit upstream of the turnstile (x+y ≈ 4.3) and every part of the
       turnstile, arms at any angle included, is nearer the viewer (x+y ≥ 5.8), so the queue is
       painted first. Painting it last put the ingots on top of the hub and arms. -->
  {#each waiting as w, i (i)}<Faces faces={w.f} />{/each}
  <Faces faces={gatePost} />
  <Faces faces={gate} />

  <!-- plan -->
  <Faces faces={table} />
  <Faces faces={gears.slice(0, 2)} />
  <Faces faces={sheet} />
  <path d={ticks.off} class="tick" />
  <path d={ticks.on} class="tick on" />
  {#if pen}<path d={pen.trail} class="ink" /><path d={pen.body} class="pen" />{/if}

  <!-- build (the ram is painted after the work item: it lands on the ingot's top face) -->
  <Faces faces={pressBack} />

  <!-- verify -->
  <Faces faces={bathBack} />

  <!-- review -->
  <Faces faces={review.base} />

  <!-- pr / ci -->
  <Faces faces={pylons} />
  <Faces faces={tower} />
  <g data-part={`lamps-${k + 1}`}>
  {#each lamps as l, i (i)}
    <Faces faces={l.f} />
    {#if l.state === "run" || l.state === "ok" || l.state === "wait"}<circle cx={l.x} cy={l.y} r="6.2" class="halo" class:calm={l.state === "ok"} />{/if}
    {#if l.cross}<path d={l.cross} class="crack" />{/if}
    {#if l.state === "fail"}<circle cx={l.x} cy={l.y} r="5.4" class="broken" />{/if}
  {/each}
  </g>

  <!-- the work item (before merge; later stages are painted over the stack) -->
  {#if vm.hasIssue && vm.stageIdx < 7}<WorkItem {k} />{/if}

  <!-- the ram and its blow, over the ingot and behind the press's front posts -->
  {#if contact}<path d={contact} class="contact" opacity={contactO} />{/if}
  <Faces faces={ram} />
  <path d={impact} class="tick on" />

  <!-- front parts, painted over the item -->
  <Faces faces={pressFront} />
  <Faces faces={gears.slice(2)} />
  <Faces faces={wheel.f} />
  {#each wheel.dots as d, i (i)}<circle cx={d.p[0]} cy={d.p[1]} r="1.6" class="pip" class:on={d.on} />{/each}
  <path d={liquid.d} class="liquid" class:flick={liquid.flick} />
  <Faces faces={bathFront} />
  {#each bubbles as b, i (i)}<circle cx={b.x} cy={b.y} r={b.r} class="bubble" opacity={b.o} />{/each}
  {#if crack}<path d={crack} class="crack" />{/if}
  <Faces faces={review.arm} />
  <path d={review.lens} class="lens f t-s1" fill-rule="evenodd" />
  <path d={review.handle} class="cable" />
  <path d={cablePath} class="cable" />
  <Faces faces={pylonB} />

  {#each sparks as sp, i (i)}<circle cx={sp.x} cy={sp.y} r={sp.r} class="spark" opacity={sp.o} />{/each}

  <!-- alive pass: per-tool actions and the "now doing" plate (painted over the stations) -->
  <ActionLayer {k} />
  <StationPlate {k} />
  <StationHits {k} {interactive} />

  <!-- hand controls -->
  <g class="hand" class:off={!estopOk}>
    <Faces faces={estop} />
    <text class="eng" transform={topMatrix(ex - 0.9, y0 + 8.3, 0.31)} font-size="0.6">stop</text>
    {#if vm.deferred}<circle cx={estopHit[0]} cy={estopHit[1]} r="11" class="deferred" />{/if}
    {#if interactive}
      <circle
        class="hit"
        cx={estopHit[0]} cy={estopHit[1]} r="19"
        role="button" tabindex="0"
        aria-label={`Stop lane ${k + 1}${vm.deferred ? " (deferred until the merge finishes)" : ""}`}
        aria-disabled={!estopOk}
        onclick={openStop} onkeydown={key(openStop)}
      />
    {/if}
  </g>
  <g class="hand" class:off={ro || !vm.canInterrupt}>
    <Faces faces={tube} />
    <text class="eng" transform={topMatrix(tubeX - 0.9, y0 + 8.3, 0.31)} font-size="0.6">steer</text>
    {#if steerGlow}<circle cx={tubeHit[0]} cy={tubeHit[1]} r="10" class="deferred" />{/if}
    {#if interactive}
      <circle
        class="hit"
        cx={tubeHit[0]} cy={tubeHit[1]} r="19"
        role="button" tabindex="0"
        aria-label={`Steer lane ${k + 1} agent`}
        aria-disabled={ro || !vm.canInterrupt}
        onclick={openSteer} onkeydown={key(openSteer)}
      />
    {/if}
  </g>
</g>

<style>
  .glow { fill: url(#g-acc); opacity: var(--glow); }
  .slat { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; opacity: 0.55; }
  .tick { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; opacity: 0.6; }
  .tick.on { stroke: var(--line); opacity: 1; stroke-width: 1.6; }
  .cable { fill: none; stroke: var(--shade-1); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .eng { fill: var(--text-dim); font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; opacity: 0.55; letter-spacing: 0.04em; }
  .eng.on { fill: var(--accent); opacity: 1; }
  .halo { fill: var(--top); opacity: 0.16; }
  .halo.calm { opacity: 0.1; }
  .broken { fill: none; stroke: var(--text-dim); stroke-width: 1; stroke-dasharray: 2 2.5; vector-effect: non-scaling-stroke; }
  .crack { fill: none; stroke: var(--line); stroke-width: 1.4; vector-effect: non-scaling-stroke; stroke-linejoin: bevel; }
  .pip { fill: var(--shade-4); stroke: var(--line); stroke-width: 0.6; }
  .pip.on { fill: var(--top); }
  .bubble { fill: none; stroke: var(--top); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .lens { fill-opacity: 1; }
  .ring { fill: none; stroke: var(--text-dim); stroke-width: 1; stroke-dasharray: 1.5 3; vector-effect: non-scaling-stroke; opacity: 0.5; }
  .arc { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .ink { fill: none; stroke: var(--line); stroke-width: 1.3; stroke-linecap: round; vector-effect: non-scaling-stroke; opacity: 0.85; }
  .pen { fill: none; stroke: var(--top); stroke-width: 2; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .spark { fill: var(--top); }
  .contact { fill: var(--line); }
  .liquid { fill: var(--shade-2); fill-opacity: 0.55; stroke: var(--top); stroke-opacity: 0.35; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .liquid.flick { fill: var(--shade-1); fill-opacity: 0.75; }
  .hit { fill: transparent; cursor: pointer; }
  .hand.off .hit { cursor: not-allowed; }
  .hand.off :global(.f) { opacity: 0.75; }
  .deferred { fill: none; stroke: var(--top); stroke-width: 1.2; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; animation: spin 6s linear infinite; transform-origin: center; transform-box: fill-box; }
  .hit:focus-visible { stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; outline: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
