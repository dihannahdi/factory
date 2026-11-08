<script lang="ts">
  // Replay mode, mounted while ui.replay is set. Picker (ui.replay.id == null) or player bar.
  // The recording is fed through store.ingest like the SSE would (see lib/replay.svelte.ts), so the
  // lane, the press, the plates and the sounds react exactly as they do live.
  import { onDestroy, onMount, untrack } from "svelte";
  import Glyph from "./Glyph.svelte";
  import { replayer, SPEEDS, segments } from "../lib/replay.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { userToClient } from "../lib/camera.svelte";
  import { project } from "../lib/iso";
  import { laneY0 } from "../lib/layout";
  import { OUTCOME_ICON, fmtElapsed, truncate } from "../lib/format";
  import { vp } from "../lib/viewport.svelte";

  const id = $derived(ui.replay?.id ?? null);
  $effect(() => {
    const want = id;
    untrack(() => {
      if (want == null) void replayer.list();
      else if (replayer.detail?.id !== want) void replayer.load(want);
    });
  });

  function choose(runId: string) { ui.replay = { id: runId }; }

  const span = (a: number, b: number) => fmtElapsed(Math.max(0, b - a));
  const clock = (ms: number) => fmtElapsed(ms / 1000);
  const segs = $derived(replayer.detail ? segments(replayer.detail) : []);
  const frac = $derived(replayer.duration > 0 ? Math.min(1, replayer.pos / replayer.duration) : 0);

  let bar = $state<HTMLElement>();
  let scrubbing = false;
  function seekAt(e: PointerEvent) {
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    replayer.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * replayer.duration);
  }
  function down(e: PointerEvent) { scrubbing = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); seekAt(e); }
  function move(e: PointerEvent) { if (scrubbing) seekAt(e); }
  function up() { scrubbing = false; }
  function barKey(e: KeyboardEvent) {
    const step = replayer.duration * 0.02;
    if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); replayer.seek(replayer.pos - step); }
    else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); replayer.seek(replayer.pos + step); }
  }

  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") { e.preventDefault(); void replayer.exit(); return; }
    const t = e.target;
    if (t instanceof Element && t.closest("input, textarea, select, button, [role=slider]")) return;
    if (e.key === " " && id != null) { e.preventDefault(); replayer.toggle(); }
  }

  // The REPLAY badge follows the lane on screen. Positioned by direct style writes (no reactive state).
  let badge = $state<HTMLElement>();
  let raf = 0;
  function place() {
    raf = requestAnimationFrame(place);
    const el = badge, d = replayer.detail;
    if (!el || !d) return;
    const [ux, uy] = project(1, laneY0(d.slot - 1) + 1, 4.2);
    const p = userToClient(ux, uy);
    if (!p) return;
    const x = Math.max(8, Math.min(window.innerWidth - 90, p.x)), y = Math.max(56, Math.min(window.innerHeight - 120, p.y));
    el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
  }
  onMount(() => {
    window.addEventListener("keydown", onKey);
    raf = requestAnimationFrame(place);
    return () => { window.removeEventListener("keydown", onKey); cancelAnimationFrame(raf); };
  });
  onDestroy(() => { if (store.replayLane != null || replayer.detail) void replayer.exit(); });
</script>

{#if id == null}
  <div class="scrim" role="presentation" onpointerdown={(e) => { if (e.target === e.currentTarget) void replayer.exit(); }}>
    <div class="picker" role="dialog" aria-modal="true" aria-label="Choose a run to replay">
      <header><span class="eng">REPLAY</span><span class="sub">pick a run, replay it on its lane</span><button class="x" onclick={() => replayer.exit()} aria-label="Close (Esc)"><Glyph name="cross" size={13} /></button></header>
      {#if replayer.runs == null}<p class="note">loading…</p>
      {:else if replayer.listError}<p class="note">{replayer.listError}</p>
      {:else if replayer.runs.length === 0}<p class="note">no recorded runs yet</p>
      {:else}
        <ul>
          {#each replayer.runs as r (r.id)}
            <li><button class="row" onclick={() => choose(r.id)}>
              <span class="oc" title={r.outcome ?? "no outcome yet"}><Glyph name={OUTCOME_ICON[r.outcome ?? ""] ?? "dots"} size={13} /></span>
              <span class="tag mono">{r.tag ?? `#${r.issue}`}</span>
              <span class="ttl">{truncate(r.title, 90)}</span>
              <span class="ln mono">L{r.slot}</span>
              <span class="dur mono">{span(r.started, r.ended)}</span>
            </button></li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{:else}
  <div class="badge eng" bind:this={badge} aria-label="Replay, not live data">REPLAY</div>
  <div class="bar" class:phone={vp.mobile} role="toolbar" aria-label="Replay player">
    {#if replayer.loading}<span class="state">loading…</span>
    {:else if replayer.error}<span class="state">{replayer.error}</span><button class="x" onclick={() => replayer.exit()} aria-label="Exit (Esc)"><Glyph name="cross" size={13} /></button>
    {:else if replayer.detail}
      <button class="play" onclick={() => replayer.toggle()} aria-label={replayer.playing ? "Pause (space)" : "Play (space)"}>
        {#if replayer.playing}<Glyph name="pause" size={14} />{:else}<svg width="14" height="14" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3.4 2.2v7.6L9.6 6z" /></svg>{/if}
      </button>
      <span class="speeds" role="group" aria-label="Speed">
        {#each SPEEDS as s (s)}<button class="sp mono" class:on={replayer.speed === s} aria-pressed={replayer.speed === s} onclick={() => replayer.setSpeed(s)}>{s}×</button>{/each}
      </span>
      <div class="scrub" bind:this={bar} role="slider" tabindex="0" aria-label="Replay position" aria-valuemin="0" aria-valuemax={Math.round(replayer.duration / 1000)} aria-valuenow={Math.round(replayer.pos / 1000)}
        onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onkeydown={barKey}>
        {#each segs as s, i (i)}<i class="seg" style:left="{s.a * 100}%" style:width="{(s.b - s.a) * 100}%" style:background="var(--shade-{(i % 4) + 1})" title={s.stage}></i>{/each}
        <i class="head" style:left="{frac * 100}%"></i>
      </div>
      <span class="info mono"><b>{replayer.stage}</b> {clock(replayer.pos)} / {clock(replayer.duration)}</span>
      <button class="x" onclick={() => replayer.exit()} aria-label="Exit replay (Esc)" title="exit  Esc"><Glyph name="out" size={14} /></button>
    {/if}
  </div>
{/if}

<style>
  .eng { font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace; letter-spacing: 0.32em; font-weight: 600; font-size: 11px; color: var(--text); text-shadow: 0 1px 0 rgba(0, 0, 0, 0.55), 0 -1px 0 rgba(255, 255, 255, 0.12); }
  .badge { position: fixed; left: 0; top: 0; z-index: 6; pointer-events: none; padding: 3px 8px 3px 11px; border: 1px solid var(--shade-2); border-radius: 3px; background: color-mix(in srgb, var(--card) 80%, transparent); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), inset 0 -1px 0 rgba(0, 0, 0, 0.4); }
  .scrim { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; background: rgba(2, 5, 9, 0.55); }
  .picker { width: min(640px, calc(100vw - 24px)); max-height: min(560px, calc(100vh - 40px)); display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--hair); border-radius: 12px; overflow: hidden; }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--hair); }
  header .sub { color: var(--text-dim); font-size: 12px; flex: 1; }
  ul { list-style: none; margin: 0; padding: 4px; overflow: auto; }
  .row { width: 100%; display: grid; grid-template-columns: 22px 74px 1fr 28px 64px; gap: 8px; align-items: center; text-align: left; padding: 9px 10px; background: transparent; border: 0; border-radius: 8px; color: var(--text); font-size: 13px; }
  .row:hover, .row:focus-visible { background: var(--card-2); }
  .oc { color: var(--top); display: grid; place-items: center; }
  .tag { color: var(--text-dim); font-size: 12px; }
  .ttl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ln, .dur { color: var(--text-dim); font-size: 12px; text-align: right; }
  .note { padding: 22px 16px; color: var(--text-dim); margin: 0; }
  .x { width: 34px; height: 34px; display: grid; place-items: center; background: transparent; border: 0; border-radius: 8px; color: var(--text); }
  .x:hover { background: var(--card-2); }

  .bar { position: fixed; z-index: 7; left: 14px; right: 380px; bottom: 14px; height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 8px; background: color-mix(in srgb, var(--card) 90%, transparent); border: 1px solid var(--hair); border-radius: 12px; backdrop-filter: blur(6px); }
  .bar.phone { left: 8px; right: 8px; bottom: 64px; }
  .bar button { background: transparent; border: 0; color: var(--text); border-radius: 8px; }
  .play { width: 34px; height: 34px; display: grid; place-items: center; flex: none; }
  .play:hover { background: var(--card-2); }
  .speeds { display: inline-flex; gap: 2px; flex: none; }
  .sp { height: 28px; padding: 0 7px; font-size: 12px; border: 1px solid var(--hair) !important; color: var(--text-dim) !important; }
  .sp.on { background: var(--top) !important; color: var(--line) !important; }
  .scrub { position: relative; flex: 1; min-width: 60px; height: 14px; border-radius: 3px; background: var(--shade-4); cursor: pointer; touch-action: none; overflow: visible; }
  .scrub:focus-visible { outline: 1px solid var(--top); outline-offset: 3px; }
  .seg { position: absolute; top: 0; bottom: 0; border-right: 1px solid var(--card); opacity: 0.9; }
  .head { position: absolute; top: -4px; bottom: -4px; width: 3px; margin-left: -1.5px; background: var(--accent); border-radius: 2px; box-shadow: 0 0 6px var(--accent); }
  .info { flex: none; font-size: 12px; color: var(--text-dim); white-space: nowrap; }
  .info b { color: var(--text); font-weight: 600; margin-right: 6px; text-transform: uppercase; letter-spacing: 0.08em; }
  .state { color: var(--text-dim); font-size: 13px; padding: 0 6px; }
  @media (max-width: 760px) { .info { display: none; } .sp { padding: 0 5px; } }
</style>
