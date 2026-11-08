<script lang="ts">
  import Sheet from "./Sheet.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { laneVM } from "../lib/lanes";
  import { stopLane } from "../lib/api";
  import { stripTag, truncate } from "../lib/format";

  let { k }: { k: number } = $props();
  let skip = $state(false);
  let busy = $state(false);
  const vm = $derived(laneVM(store.snap.slots[k - 1], store.now));
  const close = () => (ui.sheet = null);
  const deferred = $derived(vm.stage === "merge" || vm.stage === "deploy" || vm.deferred);
  async function go() {
    busy = true;
    const r = await stopLane(k, skip);
    busy = false;
    if (r.ok) { ui.say(deferred ? "stop deferred until the merge finishes" : "stop sent"); close(); }
  }
</script>

<Sheet title={`Stop lane ${k}`} onclose={close}>
  {#if vm.hasIssue}
    <p class="what"><span class="mono tag">{vm.tag}</span> {truncate(stripTag(vm.title), 80)}</p>
    {#if deferred}
      <p class="hint">In <b>{vm.stage}</b>: the stop is <b>deferred</b> until merge and deploy finish, so nothing is cut off halfway.</p>
    {:else}
      <p class="hint">The outcome is <b>stopped</b>, not failed. The issue goes back to the queue.</p>
    {/if}
    <label class="sw">
      <input type="checkbox" bind:checked={skip} />
      <span class="track" aria-hidden="true"><i></i></span>
      <span>skip this issue</span>
    </label>
    <div class="row">
      <button class="btn" onclick={close}>cancel</button>
      <button class="btn go" onclick={go} disabled={busy || store.snap.readonly} data-autofocus>{busy ? "…" : "stop"}</button>
    </div>
  {:else}
    <p class="hint">This lane is not working on an issue.</p>
  {/if}
</Sheet>

<style>
  .what { margin: 0 0 10px; font-size: 14px; }
  .tag { font-weight: 600; margin-right: 6px; }
  .hint { margin: 0 0 16px; color: var(--text-dim); font-size: 13px; line-height: 1.5; }
  .hint b { color: var(--text); font-weight: 500; }
  .sw { display: flex; align-items: center; gap: 12px; margin: 0 0 20px; min-height: 44px; cursor: pointer; position: relative; }
  .sw input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .track { width: 40px; height: 22px; border-radius: 11px; background: var(--shade-4); position: relative; transition: background 0.15s; flex: none; border: 1px solid var(--line); }
  .track i { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--text-dim); transition: transform 0.15s, background 0.15s; }
  input:checked + .track { background: var(--shade-2); }
  input:checked + .track i { transform: translateX(18px); background: var(--top); }
  input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .row { display: flex; gap: 10px; justify-content: flex-end; }
  .btn { min-height: 44px; padding: 0 20px; border-radius: 10px; border: 1px solid var(--hair); background: transparent; letter-spacing: 0.03em; }
  .btn.go { background: var(--top); color: var(--line); border-color: var(--top); font-weight: 600; }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
