<script lang="ts">
  // Margin readout for one lane. Mono numbers, one-line strings, nothing the machine does not also
  // show. The aria-live line only changes when the tag, stage or sub changes (never on the ticking
  // clock), which is what keeps screen-reader chatter throttled.
  import Glyph from "./Glyph.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { laneVM } from "../lib/lanes";
  import { anim } from "../lib/anim.svelte";
  import { CountUp, liveTokens } from "../lib/livetokens.svelte";
  import { STAGES } from "../lib/types";
  import { cachePct, fmtElapsed, fmtNum, oneLine, safeUrl, shortModel, stripTag, toolGlyph, truncate } from "../lib/format";

  let { k }: { k: number } = $props();

  const vm = $derived(laneVM(store.snap.slots[k], store.now));
  const slot = $derived(vm.slot);
  const ro = $derived(store.snap.readonly);
  const items = $derived(([...(store.snap.activity[String(k + 1)] ?? [])].slice(-6).reverse()));
  const tok = $derived(slot.tokens);
  // live tokens: slot.tokens plus the steps of the running turn, eased so the number counts up
  const live_ = $derived(liveTokens(k));
  const cIn = new CountUp(), cOut = new CountUp();
  const shownIn = $derived(Math.round(cIn.read(live_.input, () => anim.t, anim.reduced)));
  const shownOut = $derived(Math.round(cOut.read(live_.output, () => anim.t, anim.reduced)));
  const req = $derived(slot.requirements);
  const issueUrl = $derived(safeUrl(slot.issue?.url));
  const prUrl = $derived(safeUrl(slot.pr?.url));
  const status = $derived.by(() => {
    if (vm.dormant) return "parked";
    if (!vm.hasIssue) return slot.state === "backoff" ? "backoff" : slot.state === "halted" ? "halted" : slot.state;
    if (slot.state === "stopping" || slot.state === "stopped") return slot.state;
    if (slot.state === "halted") return "halted";
    return vm.stage ?? slot.state;
  });
  const note = $derived(oneLine(slot.note));
  const live = $derived(
    vm.dormant ? `Lane ${k + 1} parkir` : vm.hasIssue ? `Lane ${k + 1}: ${vm.tag}, ${status}${vm.sub ? ", " + vm.sub : ""}` : `Lane ${k + 1}: ${status}`,
  );
  const stopOff = $derived(ro || !vm.canInterrupt);
  const line = (i: (typeof items)[number]): string => {
    switch (i.kind) {
      case "tool": return oneLine(i.target) || oneLine(i.tool);
      case "text": return oneLine(i.text);
      case "step": return i.tokens ? `${fmtNum(i.tokens.in)} in · ${fmtNum(i.tokens.out)} out` : "step";
      default: return oneLine(i.text);
    }
  };
  const mark = (i: (typeof items)[number]): string => (i.kind === "tool" ? toolGlyph(i.tool) : i.kind === "text" ? "”" : i.kind === "step" ? "·" : "!");
</script>

<article
  class="lane"
  class:dormant={vm.dormant}
  class:working={vm.working}
  class:flash={ui.focusLane === k}
  data-lane={k + 1}
  onpointerenter={() => (ui.hoverLane = k)}
  onpointerleave={() => (ui.hoverLane = null)}
  onfocusin={() => (ui.hoverLane = k)}
  onfocusout={() => (ui.hoverLane = null)}
>
  <p class="sr" aria-live="polite" role="status">{live}</p>

  <div class="head">
    <span class="n mono" aria-hidden="true">{k + 1}</span>
    {#if vm.hasIssue}
      {#if issueUrl}<a class="tag mono" href={issueUrl} target="_blank" rel="noopener noreferrer">{vm.tag}</a>{:else}<span class="tag mono">{vm.tag}</span>{/if}
    {:else}
      <span class="tag mono dim">—</span>
    {/if}
    <span class="stage mono">{status}{#if vm.sub}<span class="sub">&nbsp;· {vm.sub}</span>{/if}</span>
    <span class="el mono" title="time in this stage">{vm.hasIssue ? fmtElapsed(vm.elapsed) : ""}</span>
  </div>

  {#if vm.hasIssue}
    <p class="title" title={slot.issue?.title}>{truncate(stripTag(slot.issue?.title ?? ""), 90)}</p>
    <div class="track" aria-hidden="true">
      {#each STAGES as s, i (s)}<i class:past={i < vm.stageIdx} class:now={i === vm.stageIdx} title={s}></i>{/each}
    </div>
    <div class="grid mono">
      <span title="tokens in / out"><b>in</b> {fmtNum(shownIn)} <b>out</b> {fmtNum(shownOut)}</span>
      <span title="share of prompt served from cache"><b>cache</b> {cachePct(tok)}%</span>
      {#if req}
        <span class="req" title="requirements done / total"><b>req</b> {req.done}/{req.total}<i class="bar" style:--p="{Math.round((req.done / Math.max(1, req.total)) * 100)}%"></i></span>
      {/if}
      <span class="model" title={slot.model ?? ""}>{shortModel(slot.model)}</span>
      {#if slot.pr}
        {#if prUrl}<a class="pr" href={prUrl} target="_blank" rel="noopener noreferrer">PR #{slot.pr.n} <Glyph name="ext" size={11} /></a>{:else}<span class="pr">PR #{slot.pr.n}</span>{/if}
      {/if}
      <span class="tot" title="total time on this issue">Σ {fmtElapsed(vm.total)}</span>
    </div>
    {#if vm.steer}
      <p class="steer mono {vm.steer.state}" title={vm.steer.message}><Glyph name="steer" size={11} /> {vm.steer.state} · {truncate(oneLine(vm.steer.message), 46)}</p>
    {/if}
    {#if vm.stale}<p class="stale mono"><Glyph name="warn" size={11} /> stale · no update yet</p>{/if}
  {:else if note && !vm.dormant}
    <p class="note">{truncate(note, 110)}</p>
  {/if}

  {#if !vm.dormant}
    <ol class="ticker mono" aria-label={`Lane ${k + 1} activity`}>
      {#each items as it, i (it.t + ":" + i + ":" + line(it))}
        <li class:err={it.kind === "error"} class:bad={it.status === "error"} style:opacity={Math.max(0.18, 1 - i * 0.15)}><b>{mark(it)}</b><span>{truncate(line(it), 96)}</span></li>
      {/each}
      {#if items.length === 0}<li class="none">·</li>{/if}
    </ol>
    <div class="acts">
      <button class="btn" disabled={stopOff} onclick={() => (ui.sheet = { kind: "stop", k: k + 1 })} aria-label={`Stop lane ${k + 1}`}>
        <Glyph name={ro ? "lock" : "stop"} /> stop{#if vm.deferred}<span class="def"> · deferred</span>{/if}
      </button>
      <button class="btn" disabled={stopOff} onclick={() => (ui.sheet = { kind: "steer", k: k + 1 })} aria-label={`Steer lane ${k + 1} agent`}>
        <Glyph name={ro ? "lock" : "steer"} /> steer
      </button>
      <!-- the only way into the inspect drawer on phones, where the machine is not clickable;
           reading never needs write access, so it stays enabled in read-only mode -->
      <button class="btn" disabled={!store.snap.slots[k]?.run_id} onclick={() => (ui.inspect = { k: k + 1, stage: store.snap.slots[k]?.stage ?? null })} aria-label={`Inspect lane ${k + 1}`}>
        <Glyph name="eye" /> inspect
      </button>
    </div>
  {/if}
</article>

<style>
  .lane { position: relative; padding: 14px 16px 12px; background: var(--card); border: 1px solid var(--hair); border-radius: 12px; transition: border-color 0.2s, opacity 0.2s; }
  .lane.working { border-color: color-mix(in srgb, var(--accent) 38%, var(--hair)); }
  .lane.flash { border-color: var(--text); box-shadow: 0 0 0 1px var(--text), 0 0 28px color-mix(in srgb, var(--text) 18%, transparent); }
  .lane.dormant { opacity: 0.5; padding-bottom: 10px; }
  .head { display: grid; grid-template-columns: auto auto 1fr auto; align-items: baseline; gap: 10px; }
  .n { width: 20px; height: 20px; display: inline-grid; place-items: center; border: 1px solid var(--text-dim); border-radius: 6px; font-size: 11px; color: var(--text-dim); }
  .working .n { border-color: var(--accent); color: var(--accent); }
  .tag { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; text-decoration: none; }
  a.tag:hover { text-decoration: underline; }
  .dim { color: var(--text-dim); }
  .stage { font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { color: var(--text-dim); }
  .el { font-size: 13px; color: var(--text); }
  .title { margin: 6px 0 10px; font-size: 13px; line-height: 1.35; color: var(--text); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; }
  .track { display: grid; grid-template-columns: repeat(10, 1fr); gap: 3px; margin-bottom: 10px; }
  .track i { height: 4px; border-radius: 1px; background: var(--shade-4); }
  .track i.past { background: var(--shade-1); }
  .track i.now { background: var(--accent); height: 6px; margin-top: -1px; }
  .grid { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11.5px; color: var(--text); }
  .grid b { color: var(--text-dim); font-weight: 400; margin-right: 2px; }
  .req { display: inline-flex; align-items: center; gap: 6px; }
  .bar { width: 38px; height: 3px; background: var(--shade-4); border-radius: 2px; position: relative; overflow: hidden; display: inline-block; }
  .bar::after { content: ""; position: absolute; inset: 0; width: var(--p); background: var(--top); }
  .model, .tot { color: var(--text-dim); }
  .pr { color: var(--text); text-decoration: none; display: inline-flex; gap: 4px; align-items: center; }
  a.pr:hover { text-decoration: underline; }
  .steer { margin: 8px 0 0; font-size: 11.5px; color: var(--text-dim); display: flex; gap: 6px; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .steer.pending { color: var(--text); }
  .steer.pending :global(svg) { animation: nudge 1.2s ease-in-out infinite; }
  .stale { margin: 8px 0 0; font-size: 11.5px; color: var(--text-dim); }
  .note { margin: 8px 0 0; font-size: 12px; color: var(--text-dim); }
  .ticker { list-style: none; margin: 12px 0 0; padding: 10px 0 0; border-top: 1px solid var(--hair); display: grid; gap: 2px; font-size: 11px; color: var(--text); min-height: 28px; }
  .ticker li { display: grid; grid-template-columns: 14px 1fr; gap: 6px; white-space: nowrap; overflow: hidden; transition: opacity 0.4s; }
  .ticker li b { color: var(--text-dim); font-weight: 600; text-align: center; }
  .ticker li span { overflow: hidden; text-overflow: ellipsis; }
  .ticker li.err span { text-decoration: underline wavy var(--text-dim); text-underline-offset: 3px; }
  .ticker li.bad span { text-decoration: line-through; text-decoration-color: var(--text-dim); }
  .none { color: var(--text-dim); }
  .acts { display: flex; gap: 8px; margin-top: 12px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 0 12px; background: transparent; border: 1px solid var(--hair); border-radius: 8px; font-size: 12px; letter-spacing: 0.03em; }
  .btn:hover:not(:disabled) { border-color: var(--text-dim); background: var(--card-2); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .def { color: var(--text-dim); }
  @keyframes nudge { 50% { transform: translateX(2px); } }
  @media (max-width: 760px) {
    .btn { min-height: 44px; padding: 0 16px; }
    .lane { border-radius: 12px; }
  }
</style>
