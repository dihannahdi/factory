<script lang="ts">
  // Tiny monochrome line icons. Drawn, not typed, so no platform ever swaps in a colour emoji.
  let { name, size = 14 }: { name: string; size?: number } = $props();
</script>

<svg class="g" width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  {#if name === "lock"}<rect x="2.4" y="5.3" width="7.2" height="5.2" rx="1" /><path d="M4 5.3V3.8a2 2 0 0 1 4 0v1.5" />
  {:else if name === "check"}<path d="M2.2 6.4l2.6 2.6 5-5.6" />
  {:else if name === "unlock"}<rect x="2.4" y="5.3" width="7.2" height="5.2" rx="1" /><path d="M4 5.3V3.8a2 2 0 0 1 3.9-.6" />
  {:else if name === "pause"}<path d="M4.2 2.6v6.8M7.8 2.6v6.8" />
  {:else if name === "chain"}<rect x="1" y="3.8" width="5.4" height="4.4" rx="2.2" /><rect x="5.6" y="3.8" width="5.4" height="4.4" rx="2.2" />
  {:else if name === "none"}<circle cx="6" cy="6" r="3.8" /><path d="M3.4 8.6l5.2-5.2" />
  {:else if name === "cross"}<path d="M3 3l6 6M9 3l-6 6" />
  {:else if name === "dots"}<circle cx="2.6" cy="6" r=".6" /><circle cx="6" cy="6" r=".6" /><circle cx="9.4" cy="6" r=".6" />
  {:else if name === "fork"}<circle cx="3.2" cy="2.8" r="1.2" /><circle cx="3.2" cy="9.2" r="1.2" /><circle cx="8.8" cy="5.2" r="1.2" /><path d="M3.2 4v4M3.2 6.4c3 0 4.4-.2 4.4-1.2" />
  {:else if name === "up"}<path d="M6 10V2.6M2.8 5.6L6 2.4l3.2 3.2" />
  {:else if name === "retry"}<path d="M9.6 6A3.6 3.6 0 1 1 8.2 3.2M9.8 1.8v2.4H7.4" />
  {:else if name === "shield"}<path d="M6 1.6l3.6 1.3v3c0 2.2-1.6 3.7-3.6 4.5C4 9.6 2.4 8.1 2.4 5.9v-3z" />
  {:else if name === "ext"}<path d="M4.6 2.4H2.4v7.2h7.2V7.4M6.4 2.4h3.2v3.2M9.6 2.4L5.4 6.6" />
  {:else if name === "stop"}<rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1" />
  {:else if name === "steer"}<path d="M2 9.8l.5-2.4 5.6-5.6 1.9 1.9-5.6 5.6zM7 2.9l1.9 1.9" />
  {:else if name === "board"}<rect x="1.8" y="2" width="3" height="8" rx=".6" /><rect x="7.2" y="2" width="3" height="5.2" rx=".6" />
  {:else if name === "sliders"}<path d="M2 3.6h8M2 8.4h8" /><circle cx="4.2" cy="3.6" r="1.3" fill="var(--paper)" /><circle cx="7.8" cy="8.4" r="1.3" fill="var(--paper)" />
  {:else if name === "theme"}<circle cx="6" cy="6" r="3.9" /><path d="M6 2.1v7.8" /><path d="M6 2.1a3.9 3.9 0 0 1 0 7.8z" fill="currentColor" />
  {:else if name === "eye"}<path d="M1 6q5-5.4 10 0-5 5.4-10 0z" /><circle cx="6" cy="6" r="1.5" />
  {:else if name === "out"}<path d="M5 2H2.4v8H5M7.6 3.8L10 6 7.6 8.2M10 6H4.6" />
  {:else if name === "up2"}<path d="M3 7.6L6 4.4l3 3.2" />
  {:else if name === "down2"}<path d="M3 4.4L6 7.6l3-3.2" />
  {:else if name === "warn"}<path d="M6 1.8l4.6 8H1.4z" /><path d="M6 5v2.4M6 8.6v.1" />
  {:else if name === "plus"}<path d="M6 2.4v7.2M2.4 6h7.2" />
  {:else if name === "fit"}<path d="M1.8 4.4V1.8h2.6M7.6 1.8h2.6v2.6M10.2 7.6v2.6H7.6M4.4 10.2H1.8V7.6" />
  {:else if name === "follow"}<circle cx="6" cy="6" r="2.2" /><path d="M6 1v2.2M6 8.8V11M1 6h2.2M8.8 6H11" />
  {:else if name === "film"}<rect x="1.4" y="2.6" width="9.2" height="6.8" rx="1" /><path d="M4 2.6v6.8M8 2.6v6.8M1.4 6h2.6M8 6h2.6" />
  {:else if name === "minus"}<path d="M2.4 6h7.2" />
  {:else if name === "map"}<rect x="1" y="2" width="3.2" height="2.6" rx=".5" /><rect x="1" y="7.4" width="3.2" height="2.6" rx=".5" /><rect x="7.8" y="4.7" width="3.2" height="2.6" rx=".5" /><path d="M4.2 3.3c2 0 1.8 2.7 3.6 2.7M4.2 8.7c2 0 1.8-2.7 3.6-2.7" />
  {/if}
</svg>

<style>
  .g { display: inline-block; vertical-align: -2px; flex: none; }
</style>
