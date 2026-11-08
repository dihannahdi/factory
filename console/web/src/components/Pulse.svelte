<script lang="ts">
  // The pulse strip: seven numbers, one word each.
  import Glyph from "./Glyph.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { logout } from "../lib/api";
  import { etaTip, fmtEta, fmtEtaRange, fmtNum, fmtWaste, tokensTip } from "../lib/format";
  import { vp } from "../lib/viewport.svelte";
  import { tokensToday, tokensTotal } from "../lib/livetokens.svelte";
  import { route } from "../lib/route.svelte";

  const m = $derived(store.snap.metrics);
  const running = $derived(store.snap.slots.filter((s) => s.run_id != null && (s.state === "running" || s.state === "draining")).length);
  const today = $derived(tokensToday()); // metrics.tokens_today + live steps since the last metrics update
  const total = $derived(tokensTotal()); // every call ever; null from an older console, which keeps today's
  const cells = $derived([
    { v: `${running}/3`, l: "lanes", t: "lanes running now" },
    { v: m ? String(m.merged_total) : "—", l: "merged", t: `merges since the pipeline started (${m ? m.merged_24h : 0} in the last 24 h)` },
    { v: m ? String(m.remaining) : "—", l: "left", t: "issues left" },
    { v: m?.eta ? fmtEtaRange(m.eta.p50_h, m.eta.p80_h) : fmtEta(m?.eta_h), l: "eta", t: etaTip(m) },
    { v: fmtWaste(m?.waste_per_productive_h_7d), l: "waste", t: "hours wasted per productive hour, 7 days" },
    { v: m?.bottleneck ?? "—", l: "slowest", t: "slowest stage (median)" },
    { v: fmtNum(total ?? today), l: "tokens", t: tokensTip(m?.tokens_total, today) },
    { v: m ? String(m.rate_limited_1h) : "—", l: "limited", t: "rate limits in the last hour" },
  ]);
  const linkLabel = $derived({ live: "live", poll: "poll", connecting: "…", offline: "offline" }[store.link]);
</script>

<header class="pulse">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <span class="name">factory</span>
    <span class="link mono" title={`connection: ${store.link}`} aria-label={`connection ${store.link}`}>
      <i class="dot {store.link}"></i>{linkLabel}
    </span>
  </div>
  <dl class="cells">
    {#each cells as c (c.l)}
      <div class="cell" title={c.t}>
        <dt class="l">{c.l}</dt>
        <dd class="v mono">{c.v}</dd>
      </div>
    {/each}
  </dl>
  <div class="tools">
    {#if !vp.mobile}
      <button class="ib" onclick={() => (ui.boardOpen = true)} aria-label="Open issue board"><Glyph name="board" size={15} /><span>board</span></button>
      {#if route.page === "map"}
        <button class="ib" onclick={() => route.go("foundry")} aria-label="Back to the Foundry"><Glyph name="board" size={15} /><span>foundry</span></button>
      {:else}
        <button class="ib" onclick={() => route.go("map")} aria-label="Open dependency map"><Glyph name="map" size={15} /><span>map</span></button>
      {/if}
      <button class="ib" onclick={() => (ui.deckOpen = true)} aria-label="Open control panel"><Glyph name="sliders" size={15} /><span>deck</span></button>
    {/if}
    <button class="ib sq" onclick={() => store.setTheme(store.theme === "dark" ? "blueprint" : "dark")} aria-label={`Theme: ${store.theme}. Switch theme`} title="theme"><Glyph name="theme" size={15} /></button>
    <button class="ib sq" onclick={() => void logout()} aria-label="Sign out" title="sign out"><Glyph name="out" size={15} /></button>
  </div>
</header>

<style>
  .pulse { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 22px; padding: 10px 20px; border-bottom: 1px solid var(--hair); background: var(--paper); position: sticky; top: 0; z-index: 20; padding-top: calc(10px + env(safe-area-inset-top)); }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .mark { width: 14px; height: 14px; background: var(--shade-2); clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%); box-shadow: inset 0 0 0 1px var(--line); position: relative; }
  .name { font-weight: 600; letter-spacing: 0.01em; font-size: 15px; white-space: nowrap; }
  .dim { color: var(--text-dim); font-weight: 400; }
  .link { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-dim); margin-left: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--text-dim); display: inline-block; }
  .dot.live { background: var(--top); border-color: var(--top); }
  .dot.poll { background: linear-gradient(90deg, var(--text-dim) 50%, transparent 50%); }
  .dot.connecting { border-style: dashed; }
  .dot.offline { border-color: var(--text-dim); background: repeating-linear-gradient(45deg, var(--text-dim) 0 2px, transparent 2px 4px); }
  .cells { margin: 0; display: flex; gap: 6px; justify-content: center; flex-wrap: nowrap; min-width: 0; overflow: hidden; }
  .cell { display: flex; flex-direction: column-reverse; align-items: flex-start; min-width: 74px; padding: 2px 14px; border-left: 1px solid var(--hair); white-space: nowrap; }
  .cell:first-child { border-left: 0; }
  .l { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-dim); }
  .v { margin: 0; font-size: 20px; line-height: 1.15; font-weight: 500; letter-spacing: -0.01em; }
  .tools { display: flex; gap: 6px; justify-self: end; }
  .ib { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 0 12px; background: transparent; border: 1px solid var(--hair); border-radius: 8px; color: var(--text); font-size: 12px; letter-spacing: 0.04em; }
  .ib:hover { border-color: var(--text-dim); background: var(--card); }
  .ib.sq { padding: 0; width: 36px; }

  /* eight tiles: below ~1240 px tighten them and let the strip scroll instead of clipping */
  @media (max-width: 1240px) and (min-width: 761px) {
    .pulse { gap: 14px; }
    .cells { overflow-x: auto; scrollbar-width: none; justify-content: flex-start; }
    .cells::-webkit-scrollbar { display: none; }
    .cell { min-width: 0; padding: 2px 10px; flex: none; }
    .v { font-size: 18px; }
  }

  @media (max-width: 760px) {
    .pulse { grid-template-columns: 1fr auto; gap: 6px 8px; padding: 8px 14px; padding-top: calc(8px + env(safe-area-inset-top)); }
    .cells { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; overflow-x: auto; scrollbar-width: none; margin: 0 -14px; padding: 0 14px; scroll-snap-type: x proximity; }
    .cells::-webkit-scrollbar { display: none; }
    .cell { min-width: 64px; padding: 0 12px; scroll-snap-align: start; flex: none; }
    .v { font-size: 18px; }
    .ib.sq { width: 44px; min-height: 44px; }
  }
</style>
