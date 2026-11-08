<script lang="ts">
  // The same controls as the machine's lever, cells, master switch and hand controls, as plain
  // HTML. This is the bottom sheet on phones; on desktop it is the accessible twin of the machine.
  import Sheet from "./Sheet.svelte";
  import Glyph from "./Glyph.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { laneVM } from "../lib/lanes";
  import { setAgents, setModels, setPaused } from "../lib/api";
  import { cells, moveBy, toggle } from "../lib/models-order";
  import { fmtCountdown, shortModel } from "../lib/format";

  const ro = $derived(store.snap.readonly);
  const ctl = $derived(store.snap.control);
  const agents = $derived(ui.pendingAgents ?? ctl.agents);
  const list = $derived(cells(store.snap.models?.free ?? [], ctl.models, store.snap.models?.paid ?? []));
  const spend = $derived(store.snap.models?.spend ?? null);
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const cool = $derived(store.snap.models?.cooldown ?? {});
  const vms = $derived([0, 1, 2].map((k) => laneVM(store.snap.slots[k], store.now)));
  const close = () => (ui.deckOpen = false);
  const rem = (id: string) => Math.max(0, (cool[id]?.until ?? 0) - store.now);
</script>

<Sheet title="Deck" onclose={close} wide>
  {#if ro}<p class="ro"><Glyph name="lock" /> read-only: controls locked</p>{/if}

  <section>
    <h3>agents</h3>
    <div class="stepper" role="group" aria-label="Number of agents">
      <button class="sq" onclick={() => void setAgents(agents - 1)} disabled={ro || agents <= 0} aria-label="Fewer agents"><Glyph name="minus" size={16} /></button>
      <output class="mono big" aria-live="polite">{agents}</output>
      <button class="sq" onclick={() => void setAgents(agents + 1)} disabled={ro || agents >= 3} aria-label="More agents"><Glyph name="plus" size={16} /></button>
      <span class="notches" aria-hidden="true">
        {#each [0, 1, 2, 3] as n (n)}<i class:on={n <= agents}></i>{/each}
      </span>
    </div>
  </section>

  <section>
    <h3>pause</h3>
    <button class="switch" role="switch" aria-checked={ctl.paused} disabled={ro} onclick={() => void setPaused(!ctl.paused)}>
      <span class="trk" aria-hidden="true"><i></i></span>
      <span>{ctl.paused ? "paused" : "running"}</span>
    </button>
  </section>

  <section>
    <h3>models</h3>
    <ol class="models">
      {#each list as c, i (c.id)}
        <li class:off={!c.on}>
          <button class="pick" role="switch" aria-checked={c.on} disabled={ro} onclick={() => void setModels(toggle(ctl.models, c.id))} aria-label={`Use model ${shortModel(c.id)}`}>
            <span class="idx mono">{c.on ? c.idx : ""}</span>
          </button>
          <span class="nm mono">{shortModel(c.id)}</span>
          {#if c.paid}<span class="go mono" title="paid: OpenCode Go">GO</span>{/if}
          {#if c.exposed}<span class="eye" title={c.trains ? "this model trains on prompts" : "the provider keeps data (not zero-retention)"}><Glyph name="eye" /></span>{:else if c.policy === "unknown"}<span class="eye mono" title="data policy not known yet">?</span>{/if}
          {#if rem(c.id) > 0}<span class="cd mono" title="cooldown">{fmtCountdown(rem(c.id))}</span>{/if}
          {#if c.on}
            <span class="mv">
              <button class="sq s" disabled={ro || c.idx <= 1} onclick={() => void setModels(moveBy(ctl.models, c.id, -1))} aria-label={`Move ${shortModel(c.id)} up`}><Glyph name="up2" /></button>
              <button class="sq s" disabled={ro || c.idx >= ctl.models.length} onclick={() => void setModels(moveBy(ctl.models, c.id, 1))} aria-label={`Move ${shortModel(c.id)} down`}><Glyph name="down2" /></button>
            </span>
          {/if}
        </li>
        {#if i === -1}{/if}
      {/each}
    </ol>
    {#if spend}
      <p class="spend mono" title="OpenCode Go spend against budget">Go {usd(spend.h5)} / ${spend.budget.h5} · 5h &nbsp; {usd(spend.week)} / ${spend.budget.week} · week &nbsp; {usd(spend.month)} / ${spend.budget.month} · month</p>
    {/if}
  </section>

  <section>
    <h3>lanes</h3>
    {#each vms as v (v.k)}
      <div class="ln" class:off={v.dormant}>
        <span class="n mono">{v.k + 1}</span>
        <span class="tg mono">{v.hasIssue ? v.tag : v.dormant ? "parked" : "idle"}</span>
        <span class="st mono">{v.hasIssue ? (v.stage ?? "") : ""}</span>
        <button class="bt" disabled={ro || !v.canInterrupt} onclick={() => { ui.deckOpen = false; ui.sheet = { kind: "stop", k: v.k + 1 }; }}><Glyph name="stop" /> stop</button>
        <button class="bt" disabled={ro || !v.canInterrupt} onclick={() => { ui.deckOpen = false; ui.sheet = { kind: "steer", k: v.k + 1 }; }}><Glyph name="steer" /> steer</button>
      </div>
    {/each}
  </section>
</Sheet>

<style>
  section { padding: 12px 0; border-top: 1px solid var(--hair); }
  section:first-of-type { border-top: 0; padding-top: 0; }
  h3 { margin: 0 0 10px; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-dim); font-weight: 500; }
  .ro { margin: 0 0 12px; color: var(--text-dim); font-size: 12px; display: flex; gap: 8px; align-items: center; }
  .stepper { display: flex; align-items: center; gap: 14px; }
  .big { font-size: 34px; min-width: 34px; text-align: center; line-height: 1; }
  .sq { width: 44px; height: 44px; display: inline-grid; place-items: center; background: transparent; border: 1px solid var(--hair); border-radius: 10px; }
  .sq.s { width: 36px; height: 36px; border-radius: 8px; }
  .sq:hover:not(:disabled) { border-color: var(--text-dim); background: var(--card-2); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .notches { display: flex; gap: 5px; margin-left: 8px; }
  .notches i { width: 18px; height: 5px; border-radius: 2px; background: var(--shade-4); }
  .notches i.on { background: var(--top); }
  .switch { display: inline-flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 6px 0 0; background: none; border: 0; }
  .trk { width: 46px; height: 26px; border-radius: 13px; background: var(--shade-4); border: 1px solid var(--line); position: relative; transition: background 0.15s; }
  .trk i { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--text-dim); transition: transform 0.15s, background 0.15s; }
  .switch[aria-checked="true"] .trk { background: var(--shade-2); }
  .switch[aria-checked="true"] .trk i { transform: translateX(20px); background: var(--top); }
  .models { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .models li { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 6px 0 4px; border: 1px solid var(--hair); border-radius: 10px; }
  .models li.off { opacity: 0.6; }
  .pick { width: 36px; height: 36px; border-radius: 8px; border: 1px solid var(--text-dim); background: transparent; display: grid; place-items: center; flex: none; }
  .pick[aria-checked="true"] { background: var(--top); border-color: var(--top); color: var(--line); font-weight: 700; }
  .idx { font-size: 13px; }
  .nm { font-size: 12.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .eye { color: var(--text-dim); display: inline-flex; font-size: 11px; }
  .go { font-size: 10px; color: var(--text); border: 1px solid var(--hair); border-radius: 6px; padding: 1px 5px; }
  .spend { margin: 8px 0 0; font-size: 11px; color: var(--text-dim); }
  .cd { font-size: 11px; color: var(--text); border: 1px solid var(--hair); border-radius: 6px; padding: 1px 6px; }
  .mv { display: flex; gap: 4px; }
  .ln { display: grid; grid-template-columns: 22px 1fr auto auto auto; gap: 10px; align-items: center; min-height: 46px; }
  .ln.off { opacity: 0.45; }
  .n { color: var(--text-dim); font-size: 12px; }
  .tg { font-weight: 600; font-size: 13px; }
  .st { font-size: 11px; color: var(--text-dim); }
  .bt { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--hair); background: transparent; font-size: 12px; }
  .bt:hover:not(:disabled) { border-color: var(--text-dim); }
  @media (max-width: 760px) { .ln { grid-template-columns: 18px 1fr auto auto; } .st { display: none; } .bt { min-height: 44px; } }
</style>
