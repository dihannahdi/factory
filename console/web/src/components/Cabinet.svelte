<script lang="ts">
  // The control cabinet: lever (agents 0..3), power cells (model order), pressure gauge + steam vent
  // (free-tier health), master switch (pause). Each is drawn as an object AND is a real focusable
  // control (slider / button / switch) with aria labels; the bottom sheet offers the same via HTML.
  import Faces from "./Faces.svelte";
  import { box, cylV, discXZ, gearXZ, line3, plate, project, topMatrix, unproject } from "../lib/iso";
  import type { Face } from "../lib/iso";
  import { anim } from "../lib/anim.svelte";
  import { flywheel } from "../lib/livetokens.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { laneVM } from "../lib/lanes";
  import { setAgents, setModels, setPaused } from "../lib/api";
  import { cells, moveBy, moveTo, sameList, toggle } from "../lib/models-order";
  import { fmtCountdown, shortModel } from "../lib/format";

  const ro = $derived(store.snap.readonly);
  const ctl = $derived(store.snap.control);
  const free = $derived(store.snap.models?.free ?? []);
  const cool = $derived(store.snap.models?.cooldown ?? {});
  const vms = $derived([0, 1, 2].map((k) => laneVM(store.snap.slots[k], store.now)));
  const agents = $derived(ui.pendingAgents ?? ctl.agents);

  // ---------------------------------------------------------------- base
  const base = $derived<Face[]>([...box(-13.2, 11.2, 0, 9.6, 16, 0.3, { top: "s4", left: "s3", right: "s4" })]);

  // ---------------------------------------------------------------- flywheel: the heartbeat (tokens/min)
  const FX = -7.4, FY = 12.3, FZ = 2.5, FR = 1.55;
  const flyBase = $derived<Face[]>([
    ...box(FX - 1.3, FY - 0.7, 0.3, 2.6, 1.0, 0.5, { top: "s2" }),
    ...box(FX - 0.25, FY - 0.35, 0.8, 0.5, 0.5, FZ - 0.8, { top: "s1" }),
  ]);
  const fly = $derived.by(() => {
    const a0 = flywheel(anim.t); // speed follows tokens/min, eased over ~1 s
    const wheel: Face[] = [
      discXZ(FX, FY + 0.05, FZ, FR, "s2", 28),
      discXZ(FX, FY + 0.06, FZ, FR * 0.8, "s4", 28),
      gearXZ(FX, FY + 0.07, FZ, FR * 0.5, 8, a0, "s1"),
      discXZ(FX, FY + 0.08, FZ, 0.22, "top", 10),
    ];
    let spokes = "";
    for (let i = 0; i < 4; i++) { const a = a0 + (i * Math.PI) / 2; spokes += line3([[FX + Math.cos(a) * 0.3, FY + 0.09, FZ + Math.sin(a) * 0.3], [FX + Math.cos(a) * FR * 0.78, FY + 0.09, FZ + Math.sin(a) * FR * 0.78]]); }
    const w = [0, 1].map((i) => { const a = a0 + i * Math.PI + 0.4; return discXZ(FX + Math.cos(a) * FR * 0.62, FY + 0.1, FZ + Math.sin(a) * FR * 0.62, 0.3, "top", 10); });
    return { wheel, spokes, w };
  });

  // ---------------------------------------------------------------- lever
  const LX = -7.2, LY0 = 15.2, LSTEP = 1.9;
  const notchY = (i: number) => LY0 + i * LSTEP;
  const slot = $derived<Face[]>([...box(LX - 0.55, LY0 - 0.9, 0.3, 1.1, LSTEP * 3 + 1.8, 0.28, { top: "s1", left: "s2", right: "s3" }), plate(LX - 0.12, LY0 - 0.7, 0.58, 0.24, LSTEP * 3 + 1.4, "s4")]);
  const handle = $derived.by(() => {
    const y = notchY(Math.max(0, Math.min(3, agents)));
    return [...cylV(LX, y, 0.58, 0.2, 1.1, 8), ...cylV(LX, y, 1.6, 0.52, 0.55, 12, { top: ro ? "s1" : "top" })];
  });
  const notches = $derived.by(() => {
    return [0, 1, 2, 3].map((i) => {
      const [x, y] = project(LX + 0.95, notchY(i), 0.3);
      const v = i === 0 ? null : vms[i - 1];
      const st = v == null ? "zero" : v.slot.state === "draining" || v.slot.state === "stopping" ? "half" : v.dormant ? "off" : "on";
      return { i, x, y, st };
    });
  });
  const leverHit = $derived(project(LX, notchY(agents), 1.9));
  let drag = $state<null | { kind: "lever" | "cell"; id?: string }>(null);

  function pointerWorld(e: PointerEvent, z: number) {
    const el = e.currentTarget as SVGGraphicsElement;
    const svg = el.ownerSVGElement ?? (el as unknown as SVGSVGElement);
    const m = svg.getScreenCTM();
    if (!m) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(m.inverse());
    return unproject(p.x, p.y, z);
  }
  const nearestNotch = (y: number) => Math.max(0, Math.min(3, Math.round((y - LY0) / LSTEP)));
  function leverDown(e: PointerEvent) {
    if (ro) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag = { kind: "lever" };
  }
  function leverMove(e: PointerEvent) {
    if (drag?.kind !== "lever") return;
    const w = pointerWorld(e, 1.6);
    if (w) ui.pendingAgents = nearestNotch(w.y);
  }
  function leverUp() {
    if (drag?.kind !== "lever") return;
    drag = null;
    const n = ui.pendingAgents;
    if (n != null && n !== ctl.agents) void setAgents(n); else ui.pendingAgents = null;
  }
  function leverKey(e: KeyboardEvent) {
    if (ro) return;
    let n = agents;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") n++;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") n--;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = 3;
    else return;
    e.preventDefault();
    n = Math.max(0, Math.min(3, n));
    if (n !== agents) void setAgents(n);
  }

  // ---------------------------------------------------------------- power cells
  const CX = -11.3, CY0 = 14.2, CSTEP = 1.95, CH = 2.4;
  const cooldownSeen = new Map<string, number>();
  let order = $state<string[] | null>(null); // while dragging: the tentative order
  const sel = $derived(order ?? ctl.models);
  const list = $derived(cells(free, sel, store.snap.models?.paid ?? []));
  const cellVM = $derived(
    list.map((c, i) => {
      const cd = cool[c.id];
      const rem = cd ? Math.max(0, cd.until - store.now) : 0;
      if (rem > 0) cooldownSeen.set(c.id, Math.max(cooldownSeen.get(c.id) ?? 0, rem));
      const charge = rem > 0 ? 1 - rem / Math.max(rem, cooldownSeen.get(c.id) ?? rem) : c.on ? 1 : 0.28;
      const y = CY0 + i * CSTEP;
      const hi = Math.max(0.05, charge * CH);
      const faces: Face[] = [
        ...cylV(CX, y, 0.3, 0.72, hi, 14, { top: c.on ? "top" : "s2" }),
        ...(hi < CH - 0.05 ? cylV(CX, y, 0.3 + hi, 0.72, CH - hi, 14, { top: "s4" }) : []),
      ];
      const eye = project(CX + 0.1, y + 0.73, 0.3 + CH * 0.5);
      const topP = project(CX, y, 0.3 + CH);
      return { c, rem, y, faces, eye, topP, charge };
    }),
  );
  function cellKey(e: KeyboardEvent, id: string, on: boolean) {
    if (ro) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); commit(toggle(ctl.models, id)); }
    else if (on && (e.key === "ArrowUp" || e.key === "ArrowDown") && (e.altKey || e.shiftKey)) {
      e.preventDefault();
      commit(moveBy(ctl.models, id, e.key === "ArrowUp" ? -1 : 1));
    }
  }
  function commit(next: string[]) {
    if (!sameList(next, ctl.models)) void setModels(next);
  }
  let down: null | { id: string; y: number; moved: boolean } = null;
  function cellDown(e: PointerEvent, id: string) {
    if (ro) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    down = { id, y: e.clientY, moved: false };
  }
  function cellMove(e: PointerEvent, id: string, on: boolean) {
    if (!down || down.id !== id) return;
    if (!down.moved && Math.abs(e.clientY - down.y) < 8) return;
    if (!on) return;
    down.moved = true;
    const w = pointerWorld(e, 1);
    if (!w) return;
    const to = Math.round((w.y - CY0) / CSTEP);
    order = moveTo(order ?? ctl.models, id, to);
  }
  function cellUp(id: string, on: boolean) {
    const d = down;
    down = null;
    if (!d || d.id !== id) return;
    if (d.moved && order) { const o = order; order = null; commit(o); }
    else { order = null; commit(toggle(ctl.models, id)); }
    void on;
  }

  // ---------------------------------------------------------------- gauge + steam vent
  const GX = -4.9, GY = 26.1, GZ = 3.3, GR = 1.7;
  const coolingN = $derived(Object.values(cool).filter((c) => c.until > store.now).length);
  const health = $derived.by(() => {
    const total = Math.max(1, free.length);
    const rl = Math.min(0.3, (store.snap.metrics?.rate_limited_1h ?? 0) * 0.06);
    return Math.max(0.04, Math.min(1, 1 - coolingN / total - rl));
  });
  const anyRunning = $derived(vms.some((v) => v.working));
  const needle = $derived.by(() => {
    const wob = anim.reduced ? 0 : anyRunning ? 0.015 * Math.sin(anim.t * 3) : 0.04 * Math.sin(anim.t * 0.9);
    const v = Math.max(0, Math.min(1, health + wob));
    const a = Math.PI * 1.15 - v * Math.PI * 1.3; // from lower-left (empty) to lower-right (full)
    return line3([[GX, GY, GZ], [GX + Math.cos(a) * (GR - 0.35), GY, GZ + Math.sin(a) * (GR - 0.35)]]);
  });
  const dial = $derived<Face[]>([
    ...cylV(GX, GY, 0.3, 0.35, GZ - GR - 0.3 + 0.1, 8, {}),
    ...box(GX - 1.0, GY - 0.9, 0.3, 2.0, 1.8, 0.3, { top: "s3" }),
    discXZ(GX, GY + 0.0, GZ, GR + 0.18, "s2", 22),
    discXZ(GX, GY + 0.01, GZ, GR - 0.12, "s4", 22),
  ]);
  const dialTicks = $derived.by(() => {
    let d = "";
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI * 1.15 - (i / 10) * Math.PI * 1.3;
      const r0 = GR - 0.2, r1 = GR - (i % 5 === 0 ? 0.55 : 0.4);
      d += line3([[GX + Math.cos(a) * r0, GY + 0.02, GZ + Math.sin(a) * r0], [GX + Math.cos(a) * r1, GY + 0.02, GZ + Math.sin(a) * r1]]);
    }
    return d;
  });
  const hub = $derived(project(GX, GY + 0.03, GZ));

  const backoffLane = $derived(vms.find((v) => v.slot.state === "backoff") ?? null);
  const backoffUntil = $derived.by(() => {
    if (!backoffLane) return 0;
    const m = /(\d{4}-\d\d-\d\dT[\d:]+Z)/.exec(backoffLane.slot.note);
    if (m) return Date.parse(m[1]) / 1000;
    const ts = ctl.models.map((id) => cool[id]?.until ?? 0).filter((t) => t > 0);
    return ts.length ? Math.min(...ts) : 0;
  });
  const VX = -9.2, VY = 25.8;
  const vent = $derived<Face[]>([...cylV(VX, VY, 0.3, 0.5, 1.6, 10), ...cylV(VX, VY, 1.9, 0.68, 0.3, 10, { top: "s4" })]);
  const puffs = $derived.by(() => {
    if (!backoffLane) return [] as { x: number; y: number; r: number; o: number }[];
    return [0, 1, 2, 3].map((i) => {
      const ph = ((anim.reduced ? 0.2 : anim.t * 0.45) + i * 0.25) % 1;
      const [x, y] = project(VX + ph * 0.8, VY - ph * 0.5, 2.3 + ph * 3.2);
      return { x, y, r: 3 + ph * 8, o: 0.55 * (1 - ph) };
    });
  });
  const ventLabel = $derived(backoffLane ? fmtCountdown(backoffUntil - store.now) : "");

  // ---------------------------------------------------------------- master switch (pause)
  const SX = -11.4, SY = 12.6;
  const sw = $derived<Face[]>([
    ...box(SX - 1.1, SY - 0.9, 0.3, 2.6, 1.8, 0.9, { top: "s1" }),
    ...box(SX - 0.3, SY - 0.35, 1.2, 0.6, 0.7, 0.18, { top: "s4" }),
    // the lever: up = running, tipped over = paused
    ...(ctl.paused ? box(SX - 0.28, SY - 0.28, 1.35, 0.56, 1.5, 0.5, { top: "top" }) : box(SX - 0.28, SY - 0.28, 1.35, 0.56, 0.56, 1.7, { top: "top" })),
  ]);
  const swHit = $derived(project(SX + 0.2, SY, 1.8));
  function togglePause() { if (!ro) void setPaused(!ctl.paused); }

  const lock = (x: number, y: number) => `M${x - 3.6} ${y - 0.5}h7.2v5.4h-7.2zM${x - 2.2} ${y - 0.5}v-2.2a2.2 2.2 0 0 1 4.4 0v2.2`;
  const lockAt = (wx: number, wy: number, wz: number) => { const p = project(wx, wy, wz); return lock(p[0], p[1]); };
</script>

<g class="cab" class:ro>
  <Faces faces={base} />
  <text class="eng" transform={topMatrix(-12.9, 27, 0.31)} font-size="0.62">power · lever · cells</text>

  <!-- flywheel -->
  <g data-part="flywheel">
    <Faces faces={flyBase} />
    <Faces faces={fly.wheel} />
    <path d={fly.spokes} class="spokes" />
    <Faces faces={fly.w} />
  </g>

  <!-- pause: master switch -->
  <Faces faces={sw} />
  <text class="eng" transform={topMatrix(SX - 1.0, SY + 1.9, 0.31)} font-size="0.6">{ctl.paused ? "paused" : "run"}</text>
  <circle
    class="hit" cx={swHit[0]} cy={swHit[1]} r="20"
    role="switch" tabindex="0" aria-checked={ctl.paused} aria-disabled={ro}
    aria-label="Pause all lanes"
    onclick={togglePause}
    onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePause(); } }}
  />
  {#if ro}<path d={lockAt(SX + 1.0, SY + 1.4, 1.4)} class="lock" />{/if}

  <!-- lever: agents -->
  <Faces faces={slot} />
  {#each notches as n (n.i)}
    <circle cx={n.x} cy={n.y} r="3.4" class="lamp {n.st}" />
    {#if n.st === "half"}<path d="M{n.x - 3.4} {n.y}a3.4 3.4 0 0 1 6.8 0z" class="lamp-half" />{/if}
    <text class="num" x={n.x + 6} y={n.y + 3}>{n.i}</text>
  {/each}
  <Faces faces={handle} />
  <circle
    class="hit" class:grab={!ro} cx={leverHit[0]} cy={leverHit[1]} r="22"
    role="slider" tabindex="0"
    aria-label="Number of agents" aria-valuemin="0" aria-valuemax="3" aria-valuenow={agents}
    aria-valuetext={`${agents} ${agents === 1 ? "agent" : "agents"}`} aria-disabled={ro} aria-orientation="vertical"
    onpointerdown={leverDown} onpointermove={leverMove} onpointerup={leverUp} onpointercancel={leverUp}
    onkeydown={leverKey}
  />
  {#if ro}<path d={lockAt(LX + 1.2, LY0 - 1.3, 0.3)} class="lock" />{/if}

  <!-- power cells -->
  {#each cellVM as cv (cv.c.id)}
    <Faces faces={cv.faces} />
    {#if cv.c.on}<text class="num big" transform={topMatrix(CX - 0.28, CY0 + 0.05 + (cv.y - CY0), 0.3 + CH + 0.01)} font-size="0.9">{cv.c.idx}</text>{/if}
    {#if cv.c.exposed}
      <g class="eye" transform="translate({cv.eye[0]} {cv.eye[1]})"><path d="M-6 0Q0 -5 6 0Q0 5 -6 0Z" /><circle r="1.7" /></g>
    {/if}
    {#if cv.c.paid}
      <text class="eng on" transform={topMatrix(CX + 1.0, cv.y + 0.2, 0.31)} font-size="0.62">GO</text>
    {/if}
    {#if cv.rem > 0}
      <text class="eng on" transform={topMatrix(CX + 1.0, cv.y - 0.5, 0.31)} font-size="0.62">{fmtCountdown(cv.rem)}</text>
    {/if}
    <circle
      class="hit" class:grab={!ro && cv.c.on} cx={cv.topP[0]} cy={cv.topP[1] + 12} r="20"
      role="button" tabindex="0"
      aria-pressed={cv.c.on}
      aria-label={`Model ${shortModel(cv.c.id)}${cv.c.on ? `, order ${cv.c.idx}` : ", spare"}${cv.c.paid ? ", paid (Go)" : ""}${cv.c.exposed ? ", data not zero-retention" : ""}${cv.rem > 0 ? `, cooldown ${fmtCountdown(cv.rem)}` : ""}`}
      aria-disabled={ro}
      onpointerdown={(e) => cellDown(e, cv.c.id)} onpointermove={(e) => cellMove(e, cv.c.id, cv.c.on)}
      onpointerup={() => cellUp(cv.c.id, cv.c.on)} onpointercancel={() => { down = null; order = null; }}
      onkeydown={(e) => cellKey(e, cv.c.id, cv.c.on)}
    />
  {/each}
  {#if ro}<path d={lockAt(CX - 1.2, CY0 - 1.2, 0.3)} class="lock" />{/if}

  <!-- gauge + vent -->
  <Faces faces={dial} />
  <path d={dialTicks} class="ticks" />
  <path d={needle} class="needle" />
  <circle cx={hub[0]} cy={hub[1]} r="2.4" class="hub" />
  <Faces faces={vent} />
  {#each puffs as p, i (i)}<circle cx={p.x} cy={p.y} r={p.r} class="puff" opacity={p.o} />{/each}
  {#if ventLabel}<text class="eng on" transform={topMatrix(VX - 0.8, VY + 1.3, 0.31)} font-size="0.62">{ventLabel}</text>{/if}
</g>

<style>
  .eng { fill: var(--text-dim); font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; opacity: 0.6; letter-spacing: 0.04em; }
  .eng.on { fill: var(--top); opacity: 1; }
  .num { fill: var(--text-dim); font: 600 8px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; }
  .num.big { fill: var(--line); font-size: 0.9px; }
  .lamp { fill: var(--shade-4); stroke: var(--line); stroke-width: 0.8; }
  .lamp.on { fill: var(--top); }
  .lamp.half { fill: var(--shade-4); }
  .lamp.zero { fill: none; }
  .lamp-half { fill: var(--top); stroke: none; }
  .hit { fill: transparent; cursor: pointer; }
  .hit.grab { cursor: grab; }
  .hit:focus-visible { stroke: var(--accent); stroke-width: 2; outline: none; }
  .hit[aria-disabled="true"] { cursor: not-allowed; }
  .eye path { fill: var(--top); stroke: var(--line); stroke-width: 0.8; }
  .eye circle { fill: var(--line); }
  .ticks { fill: none; stroke: var(--top); stroke-width: 1; vector-effect: non-scaling-stroke; opacity: 0.8; }
  .needle { fill: none; stroke: var(--top); stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linecap: round; }
  .hub { fill: var(--top); stroke: var(--line); stroke-width: 0.8; }
  .puff { fill: var(--top); }
  .lock { fill: var(--shade-4); stroke: var(--text-dim); stroke-width: 1.1; stroke-linejoin: round; }
  .ro :global(.f) { opacity: 0.8; }
  .spokes { fill: none; stroke: var(--line); stroke-width: 1.6; vector-effect: non-scaling-stroke; stroke-linecap: round; }
</style>
