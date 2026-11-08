<script lang="ts">
  // Floating camera control (+ − fit follow, cinematic) and the keyboard: + − 0 arrows F H.
  import { onMount } from "svelte";
  import Glyph from "./Glyph.svelte";
  import { cam, fit, panFraction, setCinematic, setFollow, setTour, zoomBy } from "../lib/camera.svelte";
  import { isOn, setOn, setVolume, volume } from "../lib/sound";
  import { store, ui } from "../lib/store.svelte";
  import { vp } from "../lib/viewport.svelte";

  const working = (k: number) => store.snap.slots[k].run_id != null && store.snap.slots[k].issue != null;

  function toggleFollow() {
    if (cam.follow) { setFollow(false); return; }
    const first = [cam.followLane, 0, 1, 2].find((k) => working(k)) ?? cam.followLane;
    setFollow(true, first);
  }

  // sound: the engine keeps the truth in localStorage; this is only its mirror for the buttons
  let soundOn = $state(isOn());
  let vol = $state(volume());
  function toggleSound() { setOn(!soundOn); soundOn = isOn(); }
  function toggleReplay() { ui.replay = ui.replay ? null : { id: null }; }

  const editable = (t: EventTarget | null): boolean => t instanceof Element && (t.closest("input, textarea, select, [contenteditable]") != null);
  const inControl = (t: EventTarget | null): boolean => t instanceof Element && t.closest("button, a, [role=slider], [role=switch], [role=button]") != null;

  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (editable(e.target)) return;
    if (e.target instanceof Element && e.target.closest("[role=dialog]")) return;
    if (ui.boardOpen || ui.deckOpen || ui.sheet) return;
    const k = e.key;
    if (k === "Escape" && ui.replay) return; // Esc leaves replay first (Replay.svelte)
    if (k === "t" || k === "T") { e.preventDefault(); setTour(!cam.tour); return; }
    if (k === "m" || k === "M") { e.preventDefault(); toggleSound(); return; }
    if (k === "r" || k === "R") { e.preventDefault(); toggleReplay(); return; }
    if (k === "Escape" && cam.cinematic) { setCinematic(false); return; }
    if (k === "h" || k === "H") { e.preventDefault(); setCinematic(!cam.cinematic); return; }
    if (k === "+" || k === "=") { e.preventDefault(); zoomBy(1.35); return; }
    if (k === "-" || k === "_") { e.preventDefault(); zoomBy(1 / 1.35); return; }
    if (k === "0") { e.preventDefault(); fit(); return; }
    if (k === "f" || k === "F") { e.preventDefault(); toggleFollow(); return; }
    if (inControl(e.target)) return; // arrows belong to sliders and buttons
    const step = 0.09;
    if (k === "ArrowLeft") { e.preventDefault(); panFraction(-step, 0); }
    else if (k === "ArrowRight") { e.preventDefault(); panFraction(step, 0); }
    else if (k === "ArrowUp") { e.preventDefault(); panFraction(0, -step); }
    else if (k === "ArrowDown") { e.preventDefault(); panFraction(0, step); }
  }
  onMount(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="camera" class:phone={vp.mobile} role="toolbar" aria-label="Camera">
  <button onclick={() => zoomBy(1.35)} aria-label="Zoom in (+)" title="zoom in  +"><Glyph name="plus" size={15} /></button>
  <button onclick={() => zoomBy(1 / 1.35)} aria-label="Zoom out (-)" title="zoom out  −"><Glyph name="minus" size={15} /></button>
  <button onclick={fit} aria-label="Fit to screen (0)" title="fit  0"><Glyph name="fit" size={15} /></button>
  <button class:on={cam.follow} aria-pressed={cam.follow} onclick={toggleFollow} aria-label="Follow agent (F)" title="follow  F"><Glyph name="follow" size={15} /></button>
  {#if cam.follow}
    <span class="chips" role="group" aria-label="Lane to follow">
      {#each [0, 1, 2] as k (k)}
        <button class="chip mono" class:on={cam.followLane === k} aria-pressed={cam.followLane === k} onclick={() => setFollow(true, k)}>{k + 1}</button>
      {/each}
    </span>
  {/if}
  <button class:on={cam.cinematic} aria-pressed={cam.cinematic} onclick={() => setCinematic(!cam.cinematic)} aria-label="Cinematic mode (H)" title="cinematic  H"><Glyph name="film" size={15} /></button>
  <button class:on={cam.tour} aria-pressed={cam.tour} onclick={() => setTour(!cam.tour)} aria-label="Auto-tour (T)" title="auto-tour  T">
    <svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="1.4" /><path d="M2.2 4.2A4.4 4.4 0 0 1 9.6 3M9.8 7.8A4.4 4.4 0 0 1 2.4 9M9.8 1.6v1.8H8M2.2 10.4V8.6H4" /></svg>
  </button>
  <button class:on={!!ui.replay} aria-pressed={!!ui.replay} onclick={toggleReplay} aria-label="Replay run (R)" title="replay  R">
    <svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.4 6a3.6 3.6 0 1 1 1.1 2.6M2.2 9V6.2h2.8M5.4 4.4v3l2.4-1.5z" /></svg>
  </button>
  <button class:on={soundOn} aria-pressed={soundOn} onclick={toggleSound} aria-label="Sound (M)" title="sound  M">
    <svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.8h1.8L6.4 2.6v6.8L3.8 7.2H2z" />{#if soundOn}<path d="M8.2 4.4a2.2 2.2 0 0 1 0 3.2M9.6 3a4.2 4.2 0 0 1 0 6" />{:else}<path d="M8 4.6l2.6 2.8M10.6 4.6L8 7.4" />{/if}</svg>
  </button>
  {#if soundOn}<input class="vol" type="range" min="0" max="1" step="0.05" bind:value={vol} oninput={() => setVolume(vol)} aria-label="Sound volume" />{/if}
</div>

<style>
  .camera { position: absolute; right: 14px; bottom: 14px; z-index: 5; display: flex; align-items: center; gap: 4px; padding: 4px; background: color-mix(in srgb, var(--card) 86%, transparent); border: 1px solid var(--hair); border-radius: 12px; backdrop-filter: blur(6px); }
  button { width: 36px; height: 36px; display: grid; place-items: center; background: transparent; border: 0; border-radius: 8px; color: var(--text); }
  button:hover { background: var(--card-2); }
  button.on { background: var(--top); color: var(--line); }
  .vol { width: 64px; accent-color: var(--top); }
  .chips { display: inline-flex; gap: 2px; padding: 0 2px; }
  .chip { width: 28px; height: 28px; font-size: 12px; border: 1px solid var(--hair); }
  .camera.phone { right: 8px; bottom: 8px; }
  .camera.phone button { width: 44px; height: 44px; }
  .camera.phone .chip { width: 36px; height: 36px; }
</style>
