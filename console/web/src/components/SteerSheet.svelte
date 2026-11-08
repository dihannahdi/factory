<script lang="ts">
  import Sheet from "./Sheet.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { laneVM } from "../lib/lanes";
  import { steerLane } from "../lib/api";
  import { stripTag, truncate } from "../lib/format";

  let { k }: { k: number } = $props();
  const MAX = 2000;
  let msg = $state("");
  let busy = $state(false);
  const vm = $derived(laneVM(store.snap.slots[k - 1], store.now));
  const close = () => (ui.sheet = null);
  const ok = $derived(msg.trim().length > 0 && msg.length <= MAX && !store.snap.readonly && vm.canInterrupt);
  async function go() {
    if (!ok) return;
    busy = true;
    const r = await steerLane(k, msg.trim());
    busy = false;
    if (r.ok) { ui.say("steer sent"); close(); }
  }
</script>

<Sheet title={`Steer lane ${k}`} onclose={close}>
  {#if vm.hasIssue}
    <p class="what"><span class="mono tag">{vm.tag}</span> {truncate(stripTag(vm.title), 80)}</p>
  {/if}
  <label class="sr" for="steer-msg">Message for the agent</label>
  <textarea id="steer-msg" bind:value={msg} rows="5" maxlength={MAX} placeholder="Use the shared retry helper, not a hand-rolled loop." onkeydown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void go(); }}></textarea>
  <div class="meta mono"><span class:over={msg.length > MAX - 100}>{msg.length}/{MAX}</span></div>
  {#if vm.steer}<p class="status mono">last: {vm.steer.state}</p>{/if}
  <div class="row">
    <button class="btn" onclick={close}>cancel</button>
    <button class="btn go" onclick={go} disabled={!ok || busy}>{busy ? "…" : "send"}</button>
  </div>
</Sheet>

<style>
  .what { margin: 0 0 12px; font-size: 14px; }
  .tag { font-weight: 600; margin-right: 6px; }
  textarea { width: 100%; resize: vertical; min-height: 110px; max-height: 40dvh; padding: 12px 14px; background: var(--paper); border: 1px solid var(--hair); border-radius: 10px; font: 13px/1.5 ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; }
  textarea:focus { outline: none; border-color: var(--accent); }
  .meta { display: flex; justify-content: flex-end; font-size: 11px; color: var(--text-dim); margin: 6px 0 12px; }
  .over { color: var(--text); }
  .status { margin: 0 0 12px; font-size: 12px; color: var(--text-dim); }
  .row { display: flex; gap: 10px; justify-content: flex-end; }
  .btn { min-height: 44px; padding: 0 20px; border-radius: 10px; border: 1px solid var(--hair); background: transparent; letter-spacing: 0.03em; }
  .btn.go { background: var(--top); color: var(--line); border-color: var(--top); font-weight: 600; }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
