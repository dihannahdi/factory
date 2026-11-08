<script lang="ts">
  import { untrack } from "svelte";
  import Machine from "./components/Machine.svelte";
  import Pulse from "./components/Pulse.svelte";
  import LaneReadout from "./components/LaneReadout.svelte";
  import Recent from "./components/Recent.svelte";
  import HaltBanner from "./components/HaltBanner.svelte";
  import Login from "./components/Login.svelte";
  import Board from "./components/Board.svelte";
  import Deck from "./components/Deck.svelte";
  import DepMap from "./components/DepMap.svelte";
  import StopSheet from "./components/StopSheet.svelte";
  import SteerSheet from "./components/SteerSheet.svelte";
  import IssueSheet from "./components/IssueSheet.svelte";
  import Glyph from "./components/Glyph.svelte";
  import CameraControls from "./components/CameraControls.svelte";
  import Inspect from "./components/Inspect.svelte";
  import AutoTour from "./components/AutoTour.svelte";
  import Replay from "./components/Replay.svelte";
  import { cam } from "./lib/camera.svelte";
  import { initAnim } from "./lib/anim.svelte";
  import { store, ui } from "./lib/store.svelte";
  import { vp } from "./lib/viewport.svelte";
  import { route } from "./lib/route.svelte";

  let fig = $state<HTMLElement>();
  let swiper = $state<HTMLElement>();
  // the observed element changes when the layout switches between phone and desktop
  $effect(() => {
    const target = vp.mobile ? swiper : fig;
    if (!target) return;
    // untracked: initAnim reads and writes animation state, which must never feed back into this effect
    return untrack(() => initAnim(target));
  });

  const issues = $derived(store.snap.github?.issues ?? []);
  const count = (c: string) => issues.filter((i) => i.class === c).length;
  const working = (k: number) => {
    const s = store.snap.slots[k];
    return s.run_id != null && (s.state === "running" || s.state === "draining");
  };
  function onScroll() {
    if (!swiper) return;
    ui.lane = Math.round(swiper.scrollLeft / Math.max(1, swiper.clientWidth));
  }
  function goLane(i: number) {
    swiper?.scrollTo({ left: i * swiper.clientWidth, behavior: "smooth" });
  }
</script>

{#if store.auth === "login"}
  <Login />
{:else if route.page === "map"}
  <div class="mappage">
    <Pulse />
    <HaltBanner />
    <DepMap />
  </div>
  {#if ui.sheet?.kind === "issue"}<IssueSheet n={ui.sheet.n} />{/if}
{:else}
  <div class="app" class:cine={cam.cinematic}>
    {#if !cam.cinematic}<Pulse />{/if}
    <HaltBanner />
    {#if vp.mobile}
      {#if !cam.cinematic}<nav class="tabs" aria-label="Choose lane">
        {#each [0, 1, 2] as i (i)}
          <button class="tab mono" class:cur={ui.lane === i} aria-current={ui.lane === i} onclick={() => goLane(i)}>
            {i + 1}{#if working(i)}<i class="pip" aria-hidden="true"></i>{/if}
          </button>
        {/each}
      </nav>{/if}
      <div class="swiper" bind:this={swiper} onscroll={onScroll}>
        {#each [0, 1, 2] as i (i)}
          <section class="slide" aria-label={`Lane ${i + 1}`}>
            <div class="fig"><Machine mode="lane" k={i} interactive={false} />{#if i === ui.lane}<CameraControls />{/if}</div>
            <LaneReadout k={i} />
          </section>
        {/each}
      </div>
    {:else}
      <main class="stage">
        <section class="figure" bind:this={fig}>
          <h2 class="serif">Foundry</h2>
          <Machine />
          <CameraControls />
        </section>
        <aside class="margin" aria-label="Lane readouts">
          {#each [0, 1, 2] as i (i)}<LaneReadout k={i} />{/each}
          {#if !cam.cinematic}<button class="rackline mono" onclick={() => (ui.boardOpen = true)} aria-label="Open issue board">
            <span><b>{count("blocked")}</b> blocked</span>
            <span><b>{count("taken")}</b> taken</span>
            <span><b>{count("failed")}</b> failed</span>
            <span><b>{store.snap.metrics?.merged_7d ?? 0}</b> stack 7d</span>
          </button>{/if}
        </aside>
      </main>
    {/if}
    {#if !cam.cinematic}<Recent />{/if}
    {#if vp.mobile && !cam.cinematic}
      <div class="bar">
        <button onclick={() => (ui.boardOpen = true)}><Glyph name="board" size={18} /> board</button>
        <button onclick={() => route.go("map")}><Glyph name="map" size={18} /> map</button>
        <button onclick={() => (ui.deckOpen = true)}><Glyph name="sliders" size={18} /> controls</button>
      </div>
    {/if}
  </div>

  {#if ui.boardOpen}<Board />{/if}
  {#if ui.deckOpen}<Deck />{/if}
  {#if ui.sheet?.kind === "stop"}<StopSheet k={ui.sheet.k} />{/if}
  {#if ui.sheet?.kind === "steer"}<SteerSheet k={ui.sheet.k} />{/if}
  {#if ui.sheet?.kind === "issue"}<IssueSheet n={ui.sheet.n} />{/if}
  {#if ui.inspect}<Inspect />{/if}
  {#if ui.replay}<Replay />{/if}
  <AutoTour />
{/if}

<div class="toast mono" role="status" aria-live="polite">{#if ui.toast}<span>{ui.toast}</span>{/if}</div>

<style>
  .mappage { height: 100dvh; display: flex; flex-direction: column; }
  @media (max-width: 760px) { .mappage { height: auto; min-height: 100dvh; } }
  .app { min-height: 100dvh; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto 1fr auto; }
  .stage { display: grid; grid-template-columns: minmax(0, 1fr) 372px; min-height: 0; height: calc(100dvh - 112px); min-height: 520px; }
  .figure { position: relative; min-width: 0; min-height: 0; overflow: hidden; padding: 0 8px; }
  .figure :global(.machine) { height: 100%; }
  .fig { position: relative; }
  .cine .stage { position: fixed; inset: 0; height: auto; min-height: 0; z-index: 3; background: var(--paper); grid-template-columns: minmax(0, 1fr); }
  .cine .figure { padding: 0; }
  .cine .figure h2 { display: none; }
  .cine .margin { position: fixed; right: 14px; top: 14px; width: 330px; max-height: calc(100dvh - 28px); padding: 0; pointer-events: none; z-index: 4; }
  .cine .margin :global(.lane) { pointer-events: auto; background: color-mix(in srgb, var(--card) 72%, transparent); backdrop-filter: blur(6px); }
  .cine .swiper { position: fixed; inset: 0; z-index: 3; background: var(--paper); align-items: stretch; }
  .figure h2 { position: absolute; left: 24px; top: 14px; margin: 0; font-size: 28px; font-weight: 400; color: var(--text); z-index: 2; }
  .margin { padding: 16px 20px 16px 4px; display: grid; gap: 10px; align-content: start; overflow-y: auto; min-height: 0; scrollbar-width: thin; }
  .rackline { display: flex; justify-content: space-between; gap: 8px; padding: 10px 14px; background: transparent; border: 1px dashed var(--hair); border-radius: 10px; font-size: 11.5px; color: var(--text-dim); text-align: left; }
  .rackline b { color: var(--text); font-weight: 500; font-size: 13px; }
  .rackline:hover { border-color: var(--text-dim); }

  .tabs { display: flex; gap: 6px; padding: 10px 14px 0; }
  .tab { position: relative; flex: 1; min-height: 44px; background: transparent; border: 1px solid var(--hair); border-radius: 10px; font-size: 15px; color: var(--text-dim); }
  .tab.cur { color: var(--text); border-color: var(--text-dim); background: var(--card); }
  .pip { position: absolute; top: 8px; right: 10px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
  .swiper { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; overscroll-behavior-x: contain; }
  .swiper::-webkit-scrollbar { display: none; }
  .slide { flex: 0 0 100%; scroll-snap-align: center; scroll-snap-stop: always; padding: 6px 14px 14px; min-width: 0; display: grid; gap: 10px; align-content: start; }
  .bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); background: color-mix(in srgb, var(--paper) 92%, transparent); backdrop-filter: blur(8px); border-top: 1px solid var(--hair); }
  .bar button { min-height: 48px; display: inline-flex; align-items: center; justify-content: center; gap: 10px; background: var(--card); border: 1px solid var(--hair); border-radius: 12px; font-size: 14px; letter-spacing: 0.04em; }
  .toast { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); z-index: 90; pointer-events: none; }
  .toast span { display: inline-block; padding: 9px 16px; background: var(--top); color: var(--line); border-radius: 10px; font-size: 12px; font-weight: 600; }
  @media (max-width: 1100px) and (min-width: 761px) { .stage { grid-template-columns: minmax(0, 1fr) 340px; } }
</style>
