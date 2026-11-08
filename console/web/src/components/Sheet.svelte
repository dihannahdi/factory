<script lang="ts">
  // Modal sheet: bottom sheet on phones, centred card on desktop. Esc and backdrop close it,
  // focus moves in and returns to whatever opened it.
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import Glyph from "./Glyph.svelte";

  let { title, onclose, children, wide = false }: { title: string; onclose: () => void; children: Snippet; wide?: boolean } = $props();
  let panel: HTMLElement;
  let opener: Element | null = null;

  onMount(() => {
    opener = document.activeElement;
    // the first enabled control: focus() on a disabled button fails silently and strands Esc outside
    const first = panel.querySelector<HTMLElement>("[data-autofocus], textarea:not(:disabled), input:not(:disabled), button:not(.x):not(:disabled)");
    (first ?? panel).focus();
    return () => (opener as HTMLElement | null)?.focus?.();
  });

  const FOCUSABLE = "button:not(:disabled), [href], input, textarea, [tabindex]:not([tabindex='-1'])";
  function key(e: KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); onclose(); return; }
    if (e.key !== "Tab") return;
    const f = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  }
</script>

<div class="veil" role="presentation" onpointerdown={(e) => { if (e.target === e.currentTarget) onclose(); }} onkeydown={key}>
  <div class="panel" class:wide bind:this={panel} role="dialog" aria-modal="true" aria-label={title} tabindex="-1">
    <header>
      <h2 class="serif">{title}</h2>
      <button class="x" onclick={onclose} aria-label="Close"><Glyph name="cross" size={14} /></button>
    </header>
    {@render children()}
  </div>
</div>

<style>
  .veil { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: color-mix(in srgb, var(--paper) 72%, transparent); backdrop-filter: blur(3px); animation: fade 0.16s ease-out; }
  .panel { width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); overflow: auto; background: var(--card); border: 1px solid var(--hair); border-radius: 14px; padding: 18px 20px 20px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45); animation: rise 0.2s ease-out; outline: none; }
  .panel.wide { width: min(560px, calc(100vw - 32px)); }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  h2 { margin: 0; font-size: 24px; font-weight: 400; }
  .x { width: 36px; height: 36px; display: grid; place-items: center; background: transparent; border: 1px solid var(--hair); border-radius: 8px; }
  .x:hover { border-color: var(--text-dim); }
  @keyframes fade { from { opacity: 0; } }
  @keyframes rise { from { transform: translateY(10px); opacity: 0; } }
  @media (max-width: 760px) {
    .veil { place-items: end center; }
    .panel, .panel.wide { width: 100%; border-radius: 18px 18px 0 0; padding-bottom: calc(20px + env(safe-area-inset-bottom)); max-height: 88dvh; animation: slide 0.24s cubic-bezier(0.2, 0.8, 0.2, 1); border-bottom: 0; }
    .x { width: 44px; height: 44px; }
  }
  @keyframes slide { from { transform: translateY(100%); } }
</style>
