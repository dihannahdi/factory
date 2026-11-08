<script lang="ts">
  // The dependency map: every issue, closed and open, as a left-to-right flow from what came first to
  // what still waits. Thick lines still hold an issue back; thin green ones are history. Click an issue to
  // see what it waits for and what it opens. Colour by state: yellow = a lane works it (the accent, same
  // as the machine), green = done, blue = unlocked, grey = locked, plum = needs a human, dotted plum =
  // held behind a plum one (stuck). Every state also
  // has its own line style and glyph, so colour never carries the meaning alone.
  import Glyph from "./Glyph.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { route } from "../lib/route.svelte";
  import { buildDepMap, chainOf, whyText, STATES } from "../lib/depmap";
  import type { MapNode, NodeState } from "../lib/depmap";
  import { stripTag, truncate } from "../lib/format";

  const W = 136, H = 46, COL = 78, ROW = 14, PAD = 28;
  const LABEL: Record<NodeState, string> = {
    running: "in progress", ready: "ready", waiting: "waiting on agent", stuck: "stuck", human: "needs a human", cycle: "cycle", done: "done",
  };
  const GLYPH: Partial<Record<NodeState, string>> = { ready: "unlock", waiting: "lock", stuck: "warn", human: "none", cycle: "retry", done: "check" };

  let showDone = $state(true);
  const doneList = $derived(store.snap.github?.done ?? []);
  const map = $derived(buildDepMap(store.snap.github?.issues ?? [], showDone ? doneList : []));
  // closed issues have no pipeline actions; they link to GitHub, built from any open issue's URL
  const repoBase = $derived((store.snap.github?.issues ?? []).map((i) => i.url.replace(/\/issues\/\d+$/, "")).find((u) => /^https:\/\/github\.com\//.test(u)) ?? null);
  const all = $derived([...map.nodes, ...map.free]);
  const byN = $derived(new Map(all.map((x) => [x.n, x])));
  const milestones = $derived([...new Set(all.map((x) => x.milestone).filter((m): m is string => !!m))].sort());

  let sel = $state<number | null>(route.issue); // ?issue=N opens the map with that issue selected
  let msFilter = $state<string | null>(null);
  let stFilter = $state<NodeState | null>(null);
  let zoom = $state(1);
  let scroller: HTMLElement;

  $effect(() => { if (sel != null && byN.size && !byN.has(sel)) sel = null; }); // unknown, or merged while selected
  $effect(() => route.setIssue(sel)); // the URL carries the selection, so a map link can be shared
  $effect(() => { if (route.issue !== sel) sel = route.issue; }); // back/forward to another ?issue=
  const chain = $derived(sel == null ? null : chainOf(map, sel));
  const cur = $derived(sel == null ? null : byN.get(sel) ?? null);

  // geometry: each layer is a column, centred against the tallest one
  const cw = $derived(PAD * 2 + Math.max(1, map.layers) * W + Math.max(0, map.layers - 1) * COL);
  const ch = $derived(PAD * 2 + Math.max(1, map.width) * H + Math.max(0, map.width - 1) * ROW);
  const counts = $derived(Array.from({ length: map.layers }, (_, r) => map.nodes.filter((x) => x.rank === r).length));
  const xy = (x: MapNode) => ({
    x: PAD + x.rank * (W + COL),
    y: PAD + ((map.width - (counts[x.rank] ?? 1)) * (H + ROW)) / 2 + x.pos * (H + ROW),
  });

  function edgePath(a: MapNode, b: MapNode): string {
    const p = xy(a), q = xy(b);
    if (a.rank === b.rank) { // inside a cycle: loop out to the right
      const x = p.x + W, y1 = p.y + H / 2, y2 = q.y + H / 2;
      return `M${x},${y1} C${x + 54},${y1} ${x + 54},${y2} ${x + 4},${y2}`;
    }
    const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x - 4, y2 = q.y + H / 2, dx = (x2 - x1) / 2;
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  const inFilter = (x: MapNode) => (!msFilter || x.milestone === msFilter) && (!stFilter || x.state === stFilter);
  const lit = (n: number) => sel != null && (n === sel || chain!.up.has(n) || chain!.down.has(n));
  const dim = (x: MapNode) => (sel != null ? !lit(x.n) : !inFilter(x));
  const edgeLit = (from: number, to: number) =>
    sel != null && ((from === sel || chain!.up.has(from)) && (to === sel || chain!.up.has(to)) ||
      (from === sel || chain!.down.has(from)) && (to === sel || chain!.down.has(to)));

  function fit() {
    if (!scroller) return;
    const z = Math.min(1, (scroller.clientWidth - 8) / cw, (scroller.clientHeight - 8) / ch);
    zoom = Math.max(0.35, Math.round(z * 100) / 100);
  }
  const zoomBy = (f: number) => (zoom = Math.min(2, Math.max(0.35, Math.round(zoom * f * 100) / 100)));

  // Click-and-hold to pan with a mouse or touchpad. A press that moves less than 4 px is still a click
  // (it selects an issue); a real drag pans and swallows the click it ends with. Touch keeps the
  // browser's own scrolling.
  let drag: { x: number; y: number; left: number; top: number; id: number } | null = null;
  let panning = $state(false);
  let swallowClick = false;
  function onDown(e: PointerEvent) {
    if (e.pointerType === "touch" || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, id: e.pointerId };
  }
  function onMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!panning) {
      if (Math.hypot(dx, dy) < 4) return;
      panning = true;
      scroller.setPointerCapture(e.pointerId);
    }
    scroller.scrollLeft = drag.left - dx;
    scroller.scrollTop = drag.top - dy;
  }
  function onUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    if (panning) { swallowClick = true; scroller.releasePointerCapture?.(e.pointerId); }
    drag = null;
    panning = false;
  }
  function onClickCapture(e: MouseEvent) {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopImmediatePropagation(); // also stops onCanvasClick, which sits on this same element
    e.preventDefault();
  }
  // a click on empty canvas (not on an issue, not the end of a drag) clears the selection; Escape is
  // the keyboard way (onKey)
  function onCanvasClick(e: MouseEvent) {
    if (!(e.target instanceof Element && e.target.closest(".node"))) sel = null;
  }
  // Pointer listeners go on through the DOM: the canvas is a scroll region, not a widget, and the
  // keyboard already has arrows (scroll) and Escape (clear) for what these do with a mouse.
  $effect(() => {
    const el = scroller;
    if (!el) return;
    const on: [string, EventListener, boolean][] = [
      ["pointerdown", onDown as EventListener, false], ["pointermove", onMove as EventListener, false],
      ["pointerup", onUp as EventListener, false], ["pointercancel", onUp as EventListener, false],
      ["click", onClickCapture as EventListener, true], ["click", onCanvasClick as EventListener, false],
    ];
    for (const [t, f, c] of on) el.addEventListener(t, f, c);
    return () => { for (const [t, f, c] of on) el.removeEventListener(t, f, c); };
  });
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls; ctrl+wheel zooms
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }
  function pick(n: number) { sel = sel === n ? null : n; }
  function key(e: KeyboardEvent, n: number) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(n); }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || ui.sheet || sel == null) return;
    sel = null;
  }
  // Fit once the first data has arrived (a direct /map load mounts before the snapshot does), then
  // bring a ?issue= selection into view.
  let fitted = false;
  $effect(() => {
    if (fitted || !scroller || map.nodes.length === 0) return;
    fitted = true;
    requestAnimationFrame(() => {
      fit();
      if (sel != null) requestAnimationFrame(() => centerOn(sel!));
    });
  });
  function centerOn(n: number) {
    const x = byN.get(n);
    if (!x || !scroller || !map.nodes.includes(x)) return;
    const p = xy(x);
    scroller.scrollLeft = (p.x + W / 2) * zoom - scroller.clientWidth / 2;
    scroller.scrollTop = (p.y + H / 2) * zoom - scroller.clientHeight / 2;
  }
  function back(e: MouseEvent) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let the browser open a new tab
    e.preventDefault();
    route.go("foundry");
  }
  const short = (m: string) => m.split(" ")[0];
</script>

<svelte:window onkeydown={onKey} />
<main class="page" aria-label="Dependency map">
    <header>
      <a class="back mono" href="/" onclick={back}><span aria-hidden="true">←</span> Foundry</a>
      <h1 class="serif">Map</h1>
      <span class="sub">flow blocked → open</span>
    </header>

    <div class="bar">
      <div class="chips" role="group" aria-label="Filter by state">
        {#each STATES as s (s)}
          <button class="chip st-{s}" class:on={stFilter === s} aria-pressed={stFilter === s} onclick={() => { stFilter = stFilter === s ? null : s; sel = null; }}>
            <i class="sw st-{s}" aria-hidden="true"></i><span class="mono">{map.summary[s]}</span> {LABEL[s]}
          </button>
        {/each}
      </div>
      <div class="chips" role="group" aria-label="Filter by milestone">
        <button class="chip" class:on={msFilter == null} aria-pressed={msFilter == null} onclick={() => (msFilter = null)}>all</button>
        {#each milestones as m (m)}
          <button class="chip mono" class:on={msFilter === m} aria-pressed={msFilter === m} title={m} onclick={() => { msFilter = msFilter === m ? null : m; sel = null; }}>{short(m)}</button>
        {/each}
      </div>
      <button class="chip" class:on={showDone} aria-pressed={showDone} onclick={() => { showDone = !showDone; sel = null; requestAnimationFrame(fit); }}
        title="closed issues and dependencies already met">
        <Glyph name="check" size={12} /> history {showDone ? "shown" : "hidden"}
      </button>
      <div class="zoom">
        <button class="ib" onclick={() => zoomBy(1 / 1.25)} aria-label="Zoom out map"><Glyph name="minus" size={14} /></button>
        <span class="mono z">{Math.round(zoom * 100)}%</span>
        <button class="ib" onclick={() => zoomBy(1.25)} aria-label="Zoom in map"><Glyph name="plus" size={14} /></button>
        <button class="ib" onclick={fit} aria-label="Fit map to screen"><Glyph name="fit" size={14} /></button>
      </div>
    </div>

    <div class="body">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scroll region must be focusable to scroll by keyboard: axe scrollable-region-focusable) -->
      <div class="canvas" class:panning bind:this={scroller} onwheel={onWheel} role="region" aria-label="Map canvas; drag to pan" tabindex="0">
        {#if map.nodes.length === 0}
          <p class="empty">No open issues wait on each other.</p>
        {:else}
          <svg width={cw * zoom} height={ch * zoom} viewBox={`0 0 ${cw} ${ch}`} role="img" aria-label={`Map of ${map.nodes.length} issues in ${map.layers} layers`}>
            <defs>
              <marker id="dm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" class="ah" />
              </marker>
              <marker id="dm-arrow-hl" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" class="ah hl" />
              </marker>
              <marker id="dm-arrow-past" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" class="ah past" />
              </marker>
            </defs>
            {#each Array.from({ length: map.layers }, (_, r) => r) as r (r)}
              <text class="lay mono" x={PAD + r * (W + COL)} y={PAD - 10}>{r === 0 ? (showDone && doneList.length ? "start" : "unblocked") : `layer ${r}`}</text>
            {/each}
            {#each map.edges as e (`${e.from}>${e.to}`)}
              {@const a = byN.get(e.from)}{@const b = byN.get(e.to)}
              {#if a && b}
                <path class="edge" class:past={!e.live} class:cy={e.cycle} class:hl={edgeLit(e.from, e.to)} class:dim={sel != null ? !edgeLit(e.from, e.to) : !(inFilter(a) && inFilter(b))}
                  d={edgePath(a, b)} marker-end={edgeLit(e.from, e.to) ? "url(#dm-arrow-hl)" : e.live ? "url(#dm-arrow)" : "url(#dm-arrow-past)"} />
              {/if}
            {/each}
            {#each map.nodes as x (x.n)}
              {@const p = xy(x)}
              <g class="node st-{x.state}" class:dim={dim(x)} class:sel={sel === x.n} transform={`translate(${p.x},${p.y})`}
                role="button" tabindex="0" aria-pressed={sel === x.n}
                aria-label={`${x.tag}: ${LABEL[x.state]}${x.unblocks ? `, opens ${x.unblocks}` : ""}`}
                onclick={() => pick(x.n)} onkeydown={(e) => key(e, x.n)}>
                <title>{x.title}</title>
                <rect width={W} height={H} rx="8" />
                <text class="tag mono" x="10" y="18">{x.tag}</text>
                {#if x.unblocks}<text class="ub mono" x={W - 8} y="18" text-anchor="end">↗{x.unblocks}</text>{/if}
                <text class="tt" x="10" y="35">{truncate(stripTag(x.title), GLYPH[x.state] ? 17 : 21)}</text>
                {#if GLYPH[x.state]}<g transform={`translate(${W - 20},${H - 19})`} class="gl"><Glyph name={GLYPH[x.state]!} size={12} /></g>{/if}
              </g>
            {/each}
          </svg>
        {/if}
      </div>

      <aside class="side" aria-live="polite">
        {#if cur}
          <h3><b class="mono">{cur.tag}</b> <span class="pill st-{cur.state}"><i class="sw st-{cur.state}" aria-hidden="true"></i>{LABEL[cur.state]}</span></h3>
          <p class="title">{stripTag(cur.title)}</p>
          <p class="why">{whyText(map, cur)}</p>
          {#if cur.deps.length}
            <h4>Still waiting on</h4>
            <ul>{#each cur.deps as d (d)}{@const y = byN.get(d)}<li><button class="ln" onclick={() => (sel = d)}><i class="sw st-{y?.state}" aria-hidden="true"></i><b class="mono">{y?.tag ?? `#${d}`}</b> <span class="lt">{truncate(stripTag(y?.title ?? ""), 44)}</span></button></li>{/each}</ul>
          {/if}
          {#if cur.past.length}
            <h4>{cur.state === "done" ? "Depended on" : "Already met"}</h4>
            <ul>{#each cur.past as d (d)}{@const y = byN.get(d)}<li><button class="ln" onclick={() => (sel = d)}><i class="sw st-{y?.state}" aria-hidden="true"></i><b class="mono">{y?.tag ?? `#${d}`}</b> <span class="lt">{truncate(stripTag(y?.title ?? ""), 44)}</span></button></li>{/each}</ul>
          {/if}
          {#if cur.dependents.length}
            <h4>{cur.state === "done" ? "Unblocked" : "Directly opens"} <span class="mono dimt">{cur.dependents.length} · total {cur.unblocks}</span></h4>
            <ul>{#each cur.dependents as d (d)}{@const y = byN.get(d)}<li><button class="ln" onclick={() => (sel = d)}><i class="sw st-{y?.state}" aria-hidden="true"></i><b class="mono">{y?.tag ?? `#${d}`}</b> <span class="lt">{truncate(stripTag(y?.title ?? ""), 44)}</span></button></li>{/each}</ul>
          {/if}
          <div class="acts">
            {#if cur.state === "done"}
              {#if repoBase}<a class="btn" href={`${repoBase}/issues/${cur.n}`} target="_blank" rel="noopener noreferrer">Open on GitHub <Glyph name="ext" size={12} /></a>{/if}
            {:else}
              <button class="btn" onclick={() => (ui.sheet = { kind: "issue", n: cur.n })}>Issue actions</button>
            {/if}
            <span class="mono dimt">#{cur.n} · {cur.milestone ? short(cur.milestone) : "—"}</span>
          </div>
        {:else}
          <h3>How to read it</h3>
          <p class="why">Arrows point from the issue being waited on to the issue that waits. The left column depends on nothing; the further right, the longer the chain. Thick lines still hold an issue back; thin ones are already met (history). <b class="mono">↗N</b> = how many issues above it open, or already opened, because of it.</p>
          <p class="why"><b>Green</b> done, <b>yellow</b> a lane is on it, <b>blue</b> unlocked and ready to pick up, <b>grey</b> still locked, <b>plum</b> needs a human, and <b>dotted plum</b> held back behind one. Every state also has its own line style and icon.</p>
          <p class="why"><b>Waiting on agent</b> opens by itself. <b>Stuck</b> opens only when a human acts on an issue marked <i>needs a human</i> or <i>cycle</i>.</p>
          {#if map.cycles.length}<p class="why warn"><Glyph name="warn" size={12} /> {map.cycles.length} {map.cycles.length === 1 ? "cycle" : "cycles"}: {map.cycles.map((c) => c.map((n) => byN.get(n)?.tag ?? `#${n}`).join(" ↔ ")).join("; ")}</p>{/if}
        {/if}
        {#if map.free.length}
          <details>
            <summary>No dependencies <span class="mono dimt">{map.free.length}</span></summary>
            <ul class="free">
              {#each map.free.filter(inFilter) as x (x.n)}
                <li><button class="ln" onclick={() => (x.state === "done" ? (sel = null) : (ui.sheet = { kind: "issue", n: x.n }))} title={x.title}><i class="sw st-{x.state}" aria-hidden="true"></i><b class="mono">{x.tag}</b> <span class="lt">{truncate(stripTag(x.title), 40)}</span></button></li>
              {/each}
            </ul>
          </details>
        {/if}
        <p class="foot">Open issues sync every 60 s; closed issues every 10 min.</p>
      </aside>
    </div>
</main>

<style>
  .page { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--paper); padding-bottom: env(safe-area-inset-bottom); }
  header { display: flex; align-items: baseline; gap: 14px; padding: 14px 20px 8px; }
  h1 { margin: 0; font-size: 28px; font-weight: 400; }
  .back { align-self: center; display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 12px; font-size: 12px; color: var(--text-dim); text-decoration: none; border: 1px solid var(--hair); border-radius: 8px; }
  .back:hover { color: var(--text); border-color: var(--text-dim); }
  .sub { color: var(--text-dim); font-size: 13px; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 4px 20px 10px; border-bottom: 1px solid var(--hair); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 10px; font-size: 12px; color: var(--text-dim); background: transparent; border: 1px solid var(--hair); border-radius: 999px; }
  .chip.on { color: var(--text); border-color: var(--text-dim); background: var(--card); }
  .chip .mono { color: var(--text); }
  .zoom { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  .ib { width: 34px; height: 34px; display: grid; place-items: center; background: transparent; border: 1px solid var(--hair); border-radius: 8px; }
  .z { font-size: 12px; color: var(--text-dim); min-width: 40px; text-align: center; }
  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 320px; }
  .canvas { overflow: auto; min-width: 0; background-image: radial-gradient(var(--grid) 1px, transparent 1px); background-size: 18px 18px; cursor: grab; }
  .canvas.panning { cursor: grabbing; user-select: none; }
  .canvas:focus-visible { outline: 2px solid var(--text-dim); outline-offset: -2px; }
  .canvas.panning .node { cursor: grabbing; }
  .empty { padding: 40px 24px; color: var(--text-dim); }
  svg { display: block; }
  .lay { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; fill: var(--text-dim); }
  .edge { fill: none; stroke: var(--shade-2); stroke-width: 1.3; transition: opacity 0.15s; }
  .edge.cy { stroke: var(--text-dim); stroke-dasharray: 6 4; }
  .edge.hl { stroke: var(--text); stroke-width: 2; }
  .edge.past { stroke: color-mix(in srgb, var(--st-done) 45%, transparent); stroke-width: 1; }
  .edge.dim { opacity: 0.12; }
  .ah { fill: var(--shade-2); }
  .ah.hl { fill: var(--text); }
  .ah.past { fill: color-mix(in srgb, var(--st-done) 60%, transparent); }
  .node { cursor: pointer; transition: opacity 0.15s; outline: none; }
  .node rect { fill: var(--card); stroke: var(--text-dim); stroke-width: 1.2; }
  .node .tag { font-size: 12px; font-weight: 600; fill: var(--text); }
  .node .tt { font-size: 10.5px; fill: var(--text-dim); }
  .node .ub { font-size: 10.5px; fill: var(--text); }
  .node .gl { color: var(--text-dim); }
  .node.st-ready rect { fill: color-mix(in srgb, var(--st-open) 16%, var(--card)); stroke: var(--st-open); stroke-width: 1.4; }
  .node.st-ready .gl { color: var(--st-open); }
  .node.st-running rect { fill: var(--accent); stroke: var(--accent); }
  .node.st-running .tag, .node.st-running .tt, .node.st-running .ub { fill: var(--accent-ink); }
  .node.st-waiting rect { stroke: var(--shade-2); stroke-dasharray: 5 3; }
  /* stuck = held behind a plum one: same hue, dotted and lighter, so the locked chain reads as one */
  .node.st-stuck rect { fill: color-mix(in srgb, var(--st-human) 11%, var(--card)); stroke: var(--st-human); stroke-width: 1.3; stroke-dasharray: 2 3; }
  .node.st-stuck .gl { color: var(--st-human); }
  .node.st-human rect { fill: color-mix(in srgb, var(--st-human) 14%, var(--paper)); stroke: var(--st-human); stroke-width: 1.4; }
  .node.st-human .gl, .node.st-cycle .gl { color: var(--st-human); }
  .node.st-cycle rect { fill: color-mix(in srgb, var(--st-human) 14%, var(--paper)); stroke: var(--st-human); stroke-dasharray: 8 3; stroke-width: 1.6; }
  .node.st-done rect { fill: color-mix(in srgb, var(--st-done) 14%, var(--paper)); stroke: var(--st-done); }
  .node.st-done .gl { color: var(--st-done); }
  .node.sel rect { stroke: var(--text); stroke-width: 2.4; stroke-dasharray: none; }
  .node:focus-visible rect { stroke: var(--text); stroke-width: 2.4; }
  .node.dim { opacity: 0.18; }
  .side { border-left: 1px solid var(--hair); padding: 14px 18px 18px; overflow-y: auto; overflow-x: hidden; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  h3 { margin: 0; font-size: 15px; font-weight: 500; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  h4 { margin: 10px 0 2px; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-dim); font-weight: 500; }
  .title { margin: 0; font-size: 13px; line-height: 1.4; }
  .why { margin: 4px 0; font-size: 12.5px; line-height: 1.5; color: var(--text-dim); }
  .why b { color: var(--text); font-weight: 500; }
  .warn { color: var(--text); display: flex; gap: 6px; align-items: baseline; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .ln { width: 100%; min-width: 0; text-align: left; display: flex; gap: 6px; align-items: center; min-height: 34px; padding: 4px 8px; font-size: 12px; background: var(--card); border: 1px solid var(--hair); border-radius: 7px; color: var(--text-dim); }
  .lt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ln b { color: var(--text); font-weight: 600; white-space: nowrap; flex: none; }
  .ln:hover { border-color: var(--text-dim); }
  .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-dim); border: 1px solid var(--hair); border-radius: 999px; padding: 2px 8px; }
  .acts { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; color: var(--text); text-decoration: none; min-height: 36px; padding: 0 14px; background: var(--card-2); border: 1px solid var(--text-dim); border-radius: 8px; font-size: 13px; }
  .dimt { color: var(--text-dim); font-size: 11px; font-weight: 400; }
  details { margin-top: 12px; border-top: 1px solid var(--hair); padding-top: 10px; }
  summary { cursor: pointer; font-size: 12px; color: var(--text-dim); }
  .free { margin-top: 8px; }
  .foot { margin-top: auto; padding-top: 12px; font-size: 11px; color: var(--text-dim); }
  /* swatches mirror the node styles, so the legend reads without colour alone */
  .sw { display: inline-block; width: 14px; height: 10px; border-radius: 3px; border: 1.2px solid var(--text-dim); background: var(--card); flex: none; }
  .sw.st-running { background: var(--accent); border-color: var(--accent); }
  .sw.st-waiting { border-style: dashed; border-color: var(--shade-2); }
  .sw.st-ready { background: color-mix(in srgb, var(--st-open) 16%, var(--card)); border-color: var(--st-open); }
  .sw.st-stuck { border-style: dotted; border-color: var(--st-human); background: color-mix(in srgb, var(--st-human) 11%, var(--card)); }
  .sw.st-human { background: color-mix(in srgb, var(--st-human) 14%, var(--paper)); border-color: var(--st-human); }
  .sw.st-cycle { border: 1.6px dashed var(--st-human); }
  .sw.st-done { background: color-mix(in srgb, var(--st-done) 14%, var(--paper)); border-color: var(--st-done); }
  @media (max-width: 760px) {
    /* phones: the page scrolls; the canvas keeps most of a screen and the panel follows below it */
    .page { flex: none; }
    .body { grid-template-columns: 1fr; grid-template-rows: 62dvh auto; }
    .side { border-left: 0; border-top: 1px solid var(--hair); max-height: none; overflow: visible; }
    .zoom { margin-left: 0; }
    .bar { padding: 4px 14px 10px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .edge, .node { transition: none; }
  }
</style>
