<script lang="ts">
  // Halt: full-width, impossible to miss, no red. Hazard stripes and a warning shape carry it.
  import Glyph from "./Glyph.svelte";
  import { store } from "../lib/store.svelte";
  import { resumeHalt } from "../lib/api";
  import { oneLine, safeUrl, truncate } from "../lib/format";

  const halt = $derived(store.snap.halt);
  const ro = $derived(store.snap.readonly);
  const url = $derived(safeUrl(halt?.issue_url));
  let busy = $state(false);
  async function resume() {
    if (!halt) return;
    busy = true;
    await resumeHalt(halt.id);
    busy = false;
  }
</script>

{#if halt}
  <section class="halt" role="alert" aria-label="System halted">
    <span class="shape" aria-hidden="true"><Glyph name="warn" size={22} /></span>
    <div class="txt">
      <b class="mono">HALT</b>
      <span class="why">{truncate(oneLine(halt.reason), 160)}</span>
      {#if url}<a href={url} target="_blank" rel="noopener noreferrer">issue <Glyph name="ext" size={11} /></a>{/if}
    </div>
    <button class="go" onclick={resume} disabled={busy || ro}>{#if ro}<Glyph name="lock" />{/if} resume</button>
  </section>
{/if}

<style>
  .halt { display: flex; align-items: center; gap: 14px; padding: 10px 20px; background: var(--top); color: var(--line); position: relative; overflow: hidden; }
  .halt::after { content: ""; position: absolute; inset: auto 0 0 0; height: 5px; background: repeating-linear-gradient(135deg, var(--line) 0 8px, transparent 8px 16px); opacity: 0.8; }
  .shape { display: grid; place-items: center; width: 34px; height: 34px; border: 2px solid var(--line); border-radius: 50%; flex: none; }
  .txt { flex: 1; min-width: 0; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  b { letter-spacing: 0.16em; font-size: 13px; }
  .why { font-size: 14px; font-weight: 500; }
  a { color: inherit; font-size: 12px; }
  .go { min-height: 40px; padding: 0 20px; background: var(--line); color: var(--top); border: 0; border-radius: 9px; font-weight: 600; letter-spacing: 0.04em; display: inline-flex; gap: 8px; align-items: center; flex: none; }
  .go:disabled { opacity: 0.5; cursor: not-allowed; }
  @media (max-width: 760px) { .halt { padding: 10px 14px 14px; flex-wrap: wrap; } .go { min-height: 44px; width: 100%; justify-content: center; } }
</style>
