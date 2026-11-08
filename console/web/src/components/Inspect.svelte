<script lang="ts">
  // The inspect drawer behind a click on a lane's station (SCHEMA 6.1): live transcript of the current
  // turn, files touched, checklist, plan, and the turn timeline. Desktop: a panel over the margin.
  // Phone: a bottom sheet with a grab handle. Every string here is untrusted text; nothing is rendered as markup.
  import { onMount, tick, untrack } from "svelte";
  import Glyph from "./Glyph.svelte";
  import { store, ui } from "../lib/store.svelte";
  import { fetchInspect, chipsOf, filterItems, itemKey, latestTouch, mergeItems, splitPath, DOM_CAP } from "../lib/inspect-api";
  import type { InspectData, InspectResult } from "../lib/inspect-api";
  import type { Item } from "../lib/types";
  import { fmtAgo, fmtElapsed, fmtNum, oneLine, safeUrl, stripTag, toolGlyph } from "../lib/format";
  import { evidenceFiles, flat, headline } from "../lib/checklist";

  const k = $derived(ui.inspect?.k ?? 1);
  const slot = $derived(store.snap.slots[k - 1]);
  const close = () => (ui.inspect = null);

  // ---------------------------------------------------------------- data: poll + live merge
  let data = $state.raw<InspectData | null>(null);
  let status = $state<"loading" | "ok" | "no_run" | "offline" | "error">("loading");
  let rows = $state.raw<Item[]>([]);
  let turnKey = "";

  const floorOf = (d: InspectData | null): number => (d?.turn?.started ? d.turn.started * 1000 - 5000 : 0);
  const live = (): Item[] => store.snap.activity?.[String(k)] ?? [];

  function ingest(r: InspectResult) {
    if (!r.ok) {
      status = r.reason === "no_run" ? "no_run" : r.reason === "offline" ? "offline" : "error";
      if (r.reason === "no_run") { data = null; rows = []; turnKey = ""; }
      return;
    }
    const d = r.data;
    status = "ok";
    data = d;
    const key = d.turn ? `${d.turn.phase}|${d.turn.started}` : "";
    const fresh = mergeItems([], d.turn?.items ?? []);
    rows = mergeItems(key === turnKey ? mergeItems(rows, fresh) : fresh, live(), floorOf(d));
    turnKey = key;
  }

  $effect(() => {
    const kk = k;
    untrack(() => { data = null; rows = []; turnKey = ""; status = "loading"; });
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { clearTimeout(timer); if (!stopped && document.visibilityState === "visible") timer = setTimeout(run, 2000); };
    async function run() {
      if (stopped || busy || document.visibilityState !== "visible") return;
      busy = true;
      const r = await fetchInspect(kk);
      busy = false;
      if (stopped) return;
      untrack(() => ingest(r));
      schedule();
    }
    const vis = () => { if (document.visibilityState === "visible") { clearTimeout(timer); void run(); } };
    document.addEventListener("visibilitychange", vis);
    void run();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", vis); };
  });

  // SSE items arrive through the store before the next poll: merge them at once so it feels instant
  $effect(() => {
    const a = store.snap.activity?.[String(k)];
    if (!a || !a.length) return;
    untrack(() => { rows = mergeItems(rows, a, floorOf(data)); });
  });

  // ---------------------------------------------------------------- transcript view
  let active = $state.raw<ReadonlySet<string>>(new Set());
  let limit = $state(DOM_CAP);
  const chips = $derived(chipsOf(rows));
  const filtered = $derived(filterItems(rows, active));
  const shown = $derived(filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered);
  const hidden = $derived(filtered.length - shown.length);
  function toggle(id: string) {
    const n = new Set(active);
    if (n.has(id)) n.delete(id); else n.add(id);
    active = n;
    stuck = true;
  }

  let scroller = $state<HTMLElement>();
  let stuck = $state(true);
  let pausedAt = $state(0);
  const unseen = $derived.by(() => {
    if (stuck) return 0;
    let n = 0;
    for (let i = filtered.length - 1; i >= 0 && filtered[i].t > pausedAt; i--) n++;
    return n;
  });
  function toBottom() { if (scroller) scroller.scrollTop = scroller.scrollHeight; }
  function onScroll() {
    if (!scroller) return;
    const at = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 28;
    if (at && !stuck) stuck = true;
    else if (!at && stuck) { stuck = false; pausedAt = filtered.length ? filtered[filtered.length - 1].t : 0; }
  }
  // keep pinned to the newest row when the box or its content changes size (window resize, filters)
  $effect(() => {
    const el = scroller;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (stuck) toBottom(); });
    ro.observe(el);
    const ol = el.querySelector("ol"); if (ol) ro.observe(ol);
    return () => ro.disconnect();
  });
  function resume() { stuck = true; void tick().then(toBottom); }
  $effect(() => {
    void shown.length;
    void shown[shown.length - 1]?.t;
    if (stuck) void tick().then(() => { if (stuck) toBottom(); });
  });

  // ---------------------------------------------------------------- header facts (snapshot first: fresher)
  const issue = $derived(slot.issue ?? data?.issue ?? null);
  const pr = $derived(slot.pr ?? data?.pr ?? null);
  const stage = $derived(slot.stage ?? data?.stage ?? null);
  const working = $derived(slot.run_id != null && (slot.state === "running" || slot.state === "draining" || slot.state === "stopping"));
  const stageEl = $derived(slot.stage_started != null ? store.now - slot.stage_started : null);
  const totalEl = $derived(slot.issue_started != null ? store.now - slot.issue_started : null);
  const prUrl = $derived(safeUrl(pr?.url));
  const ciUrl = $derived(prUrl && slot.ci ? `${prUrl}/checks` : null);
  const issueUrl = $derived(safeUrl(issue?.url));

  // ---------------------------------------------------------------- files, checklist, plan, turns
  const touch = $derived(latestTouch(rows));
  const files = $derived.by(() => {
    const list = (data?.files ?? []).map((f) => ({ ...f }));
    const t = touch;
    if (t) {
      const f = list.find((x) => x.path === t.path);
      if (f) f.last = Math.max(f.last, t.t);
      else list.push({ path: t.path, edits: 0, reads: 0, last: t.t });
    }
    return list.sort((a, b) => b.last - a.last).slice(0, 60);
  });
  const maxEdit = $derived(Math.max(1, ...files.map((f) => f.edits)));
  const maxRead = $derived(Math.max(1, ...files.map((f) => f.reads)));
  const check = $derived(data?.checklist ?? null);
  const checkDone = $derived(check ? check.filter((c) => c.done).length : (slot.requirements?.done ?? 0));
  const checkTotal = $derived(check ? check.length : (slot.requirements?.total ?? 0));
  let openRows = $state<number[]>([]);
  const toggleRow = (i: number) => (openRows = openRows.includes(i) ? openRows.filter((x) => x !== i) : [...openRows, i]);
  const plan = $derived(data?.plan ?? null);
  const turns = $derived(data?.turns ?? []);
  const curTurn = $derived.by(() => {
    if (!slot.turn) return -1;
    const i = turns.findIndex((t) => t.file && slot.turn!.events.endsWith(t.file));
    return i >= 0 ? i : turns.length - 1;
  });
  const turnGrow = $derived.by(() => {
    const spans = turns.map((t) => Math.max(1, t.last - t.first));
    const sum = spans.reduce((a, b) => a + b, 0) || 1;
    return spans.map((s) => Math.max(s, sum * 0.07));
  });

  type Tab = "files" | "check" | "plan";
  const st0 = ui.inspect?.stage;
  let tab = $state<Tab>(st0 === "plan" ? "plan" : st0 === "verify" || st0 === "review" ? "check" : "files");

  // ---------------------------------------------------------------- rows
  const rel = (t: number) => fmtAgo(t / 1000, store.now);
  function main(it: Item): string {
    if (it.kind === "tool") return oneLine(it.target) || it.tool || "tool";
    if (it.kind === "step") return `step · ${fmtNum(it.tokens?.in)} in · ${fmtNum(it.tokens?.out)} out`;
    return oneLine(it.text);
  }
  const failed = (it: Item) => it.kind === "tool" && it.status != null && it.status !== "completed" && it.status !== "running" && it.status !== "pending";

  // ---------------------------------------------------------------- dialog plumbing
  let panel: HTMLElement;
  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.focus();
    return () => opener?.focus?.({ preventScroll: true });
  });
  const FOCUSABLE = "button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";
  function key(e: KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const f = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!f.length) { e.preventDefault(); panel.focus(); return; }
    const a = f[0], z = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === a || document.activeElement === panel)) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  }

  // phone: drag the handle down to dismiss
  let dragY = $state(0);
  let dragFrom = $state<number | null>(null);
  function gDown(e: PointerEvent) { dragFrom = e.clientY; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }
  function gMove(e: PointerEvent) { if (dragFrom != null) dragY = Math.max(0, e.clientY - dragFrom); }
  function gUp() { if (dragFrom == null) return; const far = dragY > 90; dragFrom = null; if (far) close(); else dragY = 0; }
</script>

<div class="veil" role="presentation" onpointerdown={(e) => { if (e.target === e.currentTarget) close(); }}>
  <div
    class="panel" class:dragging={dragFrom != null}
    style:transform={dragY ? `translateY(${dragY}px)` : undefined}
    bind:this={panel} role="dialog" aria-modal="true" aria-label={`Inspect lane ${k}`} tabindex="-1" onkeydown={key}
  >
    <div class="grab" role="presentation" onpointerdown={gDown} onpointermove={gMove} onpointerup={gUp} onpointercancel={gUp}><i></i></div>

    <header>
      <div class="r1">
        <h2 class="serif">Lane {k}</h2>
        <span class="mono el" title="in this stage · total on the issue">
          {#if stageEl != null}{fmtElapsed(stageEl)}{/if}{#if totalEl != null}<em>{fmtElapsed(totalEl)}</em>{/if}
        </span>
        <button class="x" onclick={close} aria-label="Close inspect"><Glyph name="cross" size={14} /></button>
      </div>
      {#if issue}
        <p class="ttl" title={issue.title}><b class="mono">{issue.tag ?? `#${issue.n}`}</b> {stripTag(issue.title)}</p>
      {:else}
        <p class="ttl dim">{status === "loading" ? "loading…" : "lane is not running an issue"}</p>
      {/if}
      <div class="r3">
        <span class="stg mono">{#if working}<i class="dot" aria-label="agent at work"></i>{/if}{stage ?? "—"}{#if slot.sub}<span class="sub"> · {oneLine(slot.sub)}</span>{/if}</span>
        <span class="links">
          {#if issueUrl}<a class="lk" href={issueUrl} target="_blank" rel="noopener noreferrer" aria-label="Open issue on GitHub"><Glyph name="ext" size={11} /> issue</a>{/if}
          {#if prUrl}<a class="lk" href={prUrl} target="_blank" rel="noopener noreferrer" aria-label="Open pull request"><Glyph name="ext" size={11} /> PR</a>{/if}
          {#if ciUrl}<a class="lk" href={ciUrl} target="_blank" rel="noopener noreferrer" aria-label="Open CI run"><Glyph name="ext" size={11} /> CI</a>{/if}
        </span>
      </div>
    </header>

    {#if turns.length}
      <div class="turns" role="img" aria-label={`Turn: ${turns.map((t) => t.phase).join(", ")}`}>
        {#each turns as t, i (t.file + i)}
          <span class="seg mono" class:cur={i === curTurn} style:flex-grow={turnGrow[i]} title={`${t.phase} · ${t.items} ${t.items === 1 ? "item" : "items"}`}>{t.phase}</span>
        {/each}
      </div>
    {/if}

    <section class="tr" aria-label="Live transcript">
      <div class="chips" role="group" aria-label="Filter tool">
        {#each chips as c (c.id)}
          <button class="chip mono" class:on={active.has(c.id)} aria-pressed={active.has(c.id)} onclick={() => toggle(c.id)}>
            <span class="cg">{c.id === "text" ? "“" : c.id === "error" ? "!" : toolGlyph(c.id)}</span>{c.id}<span class="n">{c.n}</span>
          </button>
        {/each}
        {#if chips.length === 0}<span class="mono dim sm">{status === "no_run" ? "no run" : "waiting for activity…"}</span>{/if}
        {#if status === "offline" || status === "error"}<span class="mono dim sm off">{status === "offline" ? "offline" : "failed to load"}</span>{/if}
      </div>
      <div class="scroll" bind:this={scroller} onscroll={onScroll} tabindex="-1" role="log" aria-live="off" aria-label="Items of the current turn">
        {#if hidden > 0}<button class="more mono" onclick={() => (limit += DOM_CAP)}>▲ {hidden} earlier</button>{/if}
        <ol>
          {#each shown as it (itemKey(it))}
            <li class="row {it.kind}" class:err={it.kind === "error"} class:bad={failed(it)}>
              <span class="g mono" aria-hidden="true">{#if it.kind === "error"}<Glyph name="warn" size={11} />{:else if it.kind === "text"}“{:else if it.kind === "step"}·{:else}{toolGlyph(it.tool)}{/if}</span>
              <span class="tx" class:mono={it.kind === "tool" || it.kind === "step"} title={main(it)}>{main(it)}{#if failed(it)} <Glyph name="cross" size={10} />{/if}</span>
              <time class="ago mono">{rel(it.t)}</time>
            </li>
          {/each}
        </ol>
      </div>
      {#if !stuck}
        <button class="livechip mono" onclick={resume} aria-label="Back to newest item"><i class="dot"></i>▼ live{#if unseen > 0} · {unseen}{/if}</button>
      {/if}
    </section>

    <section class="low" aria-label="Details">
      <div class="tabs" role="tablist" aria-label="Run details">
        <button role="tab" aria-selected={tab === "files"} class="tab mono" class:cur={tab === "files"} onclick={() => (tab = "files")}>files<span class="n">{files.length}</span></button>
        <button role="tab" aria-selected={tab === "check"} class="tab mono" class:cur={tab === "check"} onclick={() => (tab = "check")}>checklist<span class="n">{checkTotal ? `${checkDone}/${checkTotal}` : "—"}</span></button>
        <button role="tab" aria-selected={tab === "plan"} class="tab mono" class:cur={tab === "plan"} onclick={() => (tab = "plan")}>plan</button>
      </div>
      <div class="body" role="tabpanel">
        {#if tab === "files"}
          {#if files.length === 0}<p class="empty mono">no files touched yet</p>{/if}
          <ul class="files">
            {#each files as f (f.path)}
              {@const p = splitPath(f.path)}
              <li class="file">
                {#key touch && touch.path === f.path ? touch.t : 0}<i class="flash" class:go={touch != null && touch.path === f.path}></i>{/key}
                <span class="path mono" title={f.path}><span class="dir">{p.dir}</span><b>{p.base}</b></span>
                <span class="bars" aria-hidden="true"><i class="be" style:width={`${(f.edits / maxEdit) * 100}%`}></i><i class="br" style:width={`${(f.reads / maxRead) * 100}%`}></i></span>
                <span class="cnt mono" aria-label={`${f.edits} edits, ${f.reads} reads`}>~{f.edits} <span class="dim">&lt;{f.reads}</span></span>
              </li>
            {/each}
          </ul>
        {:else if tab === "check"}
          {#if checkTotal}
            <!-- one segment per requirement, like the lane card's stage track -->
            <div class="seg" role="img" aria-label={`${checkDone} of ${checkTotal} requirements done`}>
              {#each { length: checkTotal } as _, i (i)}<i class:on={check ? check[i].done : i < checkDone}></i>{/each}
              <span class="mono">{checkDone}/{checkTotal}</span>
            </div>
          {/if}
          {#if check && check.length}
            <!-- one line per requirement; the full sentence and its evidence wait behind a click -->
            <ul class="check">
              {#each check as c, i (i)}
                {@const hl = headline(c.item)}
                {@const files = evidenceFiles(c.evidence)}
                {@const open = openRows.includes(i)}
                <li class:done={c.done} class:open>
                  <button class="ck-row" aria-expanded={open} onclick={() => toggleRow(i)}>
                    <span class="tk" aria-label={c.done ? "done" : "not yet"}>{#if c.done}<Glyph name="check" size={10} />{/if}</span>
                    <span class="hl">{hl}</span>
                    <i class="car" aria-hidden="true"></i>
                  </button>
                  {#if open}
                    <div class="ck-more">
                      {#if hl !== flat(c.item)}<p class="ck-full">{c.item}</p>{/if}
                      {#if files.length}<p class="ck-files">{#each files as f (f)}<span class="ck-file mono">{f}</span>{/each}</p>{/if}
                      {#if c.evidence}<p class="ck-ev mono">{c.evidence}</p>{/if}
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="empty mono">{checkTotal ? "no details for this run yet" : "no checklist yet"}</p>
          {/if}
        {:else}
          {#if plan && (plan.slice || plan.requirements.length)}
            {#if plan.decision}<p class="dec mono">{plan.decision}</p>{/if}
            {#if plan.slice}<p class="slice">{plan.slice}</p>{/if}
            {#if plan.requirements.length}
              <h4 class="mono">requirements</h4>
              <ol class="req">{#each plan.requirements as r, i (i)}<li>{r}</li>{/each}</ol>
            {/if}
            {#if plan.files.length}<h4 class="mono">files</h4><p class="pf mono">{plan.files.join("  ")}</p>{/if}
            {#if plan.tests}<h4 class="mono">tests</h4><p class="pf mono">{plan.tests}</p>{/if}
          {:else}
            <p class="empty mono">no plan yet</p>
          {/if}
        {/if}
      </div>
    </section>
  </div>
</div>

<style>
  .veil { position: fixed; inset: 0; z-index: 52; background: color-mix(in srgb, var(--paper) 38%, transparent); animation: fade 0.16s ease-out; }
  .panel {
    position: absolute; top: 0; right: 0; bottom: 0; width: min(440px, 100vw);
    display: flex; flex-direction: column;
    background: var(--paper); border-left: 1px solid var(--hair); box-shadow: -24px 0 60px rgba(0, 0, 0, 0.35);
    outline: none; animation: in 0.26s cubic-bezier(0.2, 0.8, 0.2, 1); padding-bottom: env(safe-area-inset-bottom); min-height: 0;
  }
  .grab { display: none; }
  header { flex: none; padding: 14px 18px 8px; padding-top: calc(14px + env(safe-area-inset-top)); display: grid; gap: 6px; }
  .r1 { display: flex; align-items: center; gap: 12px; }
  h2 { margin: 0; font-size: 26px; font-weight: 400; line-height: 1; }
  .el { margin-left: auto; font-size: 13px; color: var(--text); }
  .el { display: inline-flex; gap: 8px; align-items: baseline; }
  .el em { font-style: normal; color: var(--text-dim); font-size: 11px; }
  .el em::before { content: "· "; }
  .x { width: 36px; height: 36px; display: grid; place-items: center; background: transparent; border: 1px solid var(--hair); border-radius: 8px; flex: none; }
  .x:hover { border-color: var(--text-dim); }
  .ttl { margin: 0; font-size: 13px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .ttl b { font-weight: 600; letter-spacing: 0.02em; margin-right: 4px; }
  .dim { color: var(--text-dim); }
  .r3 { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 26px; }
  .stg { font-size: 11.5px; color: var(--text-dim); display: inline-flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .sub { overflow: hidden; text-overflow: ellipsis; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); display: inline-block; flex: none; }
  .links { display: inline-flex; gap: 6px; flex: none; }
  .lk { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; padding: 4px 8px; border: 1px solid var(--hair); border-radius: 7px; text-decoration: none; color: var(--text-dim); min-height: 26px; }
  .lk:hover { color: var(--text); border-color: var(--text-dim); }

  .turns { flex: none; display: flex; gap: 2px; padding: 0 18px 10px; height: 26px; box-sizing: content-box; }
  .seg { flex-basis: 0; min-width: 0; height: 16px; align-self: end; background: var(--card-2); border: 1px solid var(--hair); border-radius: 3px; font-size: 9px; line-height: 14px; color: var(--text-dim); padding: 0 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .seg.cur { background: color-mix(in srgb, var(--accent) 22%, var(--card-2)); border-color: var(--accent); color: var(--text); }

  .tr { position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr); flex: 1 1 0; min-height: 0; border-top: 1px solid var(--hair); }
  .chips { display: flex; gap: 5px; padding: 8px 18px; overflow-x: auto; scrollbar-width: none; align-items: center; min-height: 41px; }
  .chips::-webkit-scrollbar { display: none; }
  .chip { display: inline-flex; align-items: center; gap: 5px; flex: none; font-size: 10.5px; padding: 3px 8px; min-height: 24px; background: transparent; color: var(--text-dim); border: 1px solid var(--hair); border-radius: 999px; }
  .chip .cg { color: var(--shade-1); width: 8px; text-align: center; }
  .chip .n { color: var(--shade-2); }
  .chip:hover { color: var(--text); border-color: var(--text-dim); }
  .chip.on { color: var(--text); border-color: var(--text); background: var(--card-2); }
  .sm { font-size: 10.5px; }
  .off { margin-left: auto; }
  .scroll { overflow-y: auto; min-height: 0; padding: 0 0 6px; scrollbar-width: thin; overscroll-behavior: contain; outline: none; }
  ol { list-style: none; margin: 0; padding: 0; }
  .more { display: block; width: calc(100% - 36px); margin: 0 18px 4px; padding: 5px; font-size: 10.5px; color: var(--text-dim); background: transparent; border: 1px dashed var(--hair); border-radius: 6px; }
  .row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 8px; align-items: baseline; padding: 3px 18px; font-size: 12px; line-height: 1.4; border-left: 2px solid transparent; }
  .row:hover { background: var(--card); }
  .g { color: var(--shade-1); text-align: center; font-size: 11px; }
  .tx { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-size: 11.5px; }
  .row.tool .tx { color: color-mix(in srgb, var(--text) 86%, var(--text-dim)); }
  .row.text .tx { white-space: normal; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; font-size: 12px; color: var(--text); }
  .row.text .g { font-family: "EB Garamond", Georgia, serif; font-size: 15px; line-height: 1; }
  .row.step { opacity: 0.55; padding-top: 1px; padding-bottom: 1px; }
  .row.step .tx { color: var(--text-dim); font-size: 10.5px; }
  .row.err { border-left-color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
  .row.err .tx { white-space: normal; font-weight: 500; }
  .row.err .g { color: var(--text); }
  .row.bad .tx { text-decoration: underline dashed var(--shade-2); text-underline-offset: 3px; }
  .ago { font-size: 10px; color: var(--shade-2); }
  .livechip { position: absolute; right: 18px; bottom: 10px; z-index: 2; display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px; min-height: 30px; font-size: 11px; color: var(--text); background: var(--card-2); border: 1px solid var(--text-dim); border-radius: 999px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4); animation: rise 0.18s ease-out; }

  .low { display: grid; grid-template-rows: auto minmax(0, 1fr); flex: 0 0 36%; min-height: 150px; border-top: 1px solid var(--hair); background: var(--card); }
  .tabs { display: flex; gap: 4px; padding: 6px 14px 0; border-bottom: 1px solid var(--hair); }
  .tab { display: inline-flex; gap: 7px; align-items: baseline; padding: 6px 8px 7px; min-height: 30px; background: transparent; border: 0; border-bottom: 2px solid transparent; font-size: 11px; color: var(--text-dim); margin-bottom: -1px; }
  .tab .n { color: var(--shade-2); font-size: 10px; }
  .tab.cur { color: var(--text); border-bottom-color: var(--text); }
  .tab:hover { color: var(--text); }
  .body { overflow-y: auto; min-height: 0; padding: 8px 18px 14px; scrollbar-width: thin; overscroll-behavior: contain; }
  .empty { margin: 14px 0; font-size: 11.5px; color: var(--text-dim); }

  .files { list-style: none; margin: 0; padding: 0; display: grid; }
  .file { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 44px auto; gap: 10px; align-items: center; padding: 4px 0; border-bottom: 1px solid color-mix(in srgb, var(--hair) 60%, transparent); }
  .path { font-size: 11px; display: flex; min-width: 0; white-space: nowrap; }
  .path .dir { color: var(--shade-2); overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
  .path b { flex: none; }
  .path b { font-weight: 600; color: var(--text); }
  .bars { display: grid; gap: 2px; }
  .bars i { display: block; height: 2px; border-radius: 1px; min-width: 2px; }
  .be { background: var(--top); }
  .br { background: var(--shade-3); }
  .cnt { font-size: 10px; color: var(--text); white-space: nowrap; }
  .flash { position: absolute; inset: 0 -6px; pointer-events: none; border-radius: 4px; opacity: 0; }
  .flash.go { animation: flash 1.1s ease-out 1; }

  .seg { display: flex; align-items: center; gap: 3px; margin: 2px 0 10px; }
  .seg i { flex: 1; height: 4px; border-radius: 1px; background: var(--shade-4); }
  .seg i.on { background: var(--top); }
  .seg span { margin-left: 8px; font-size: 11px; color: var(--text-dim); }
  .check { list-style: none; margin: 0 -6px; padding: 0; display: grid; gap: 1px; }
  .ck-row { width: 100%; display: grid; grid-template-columns: 14px minmax(0, 1fr) 8px; align-items: center; gap: 10px; padding: 7px 6px; background: transparent; border: 0; border-radius: 6px; text-align: left; font-size: 12.5px; color: var(--text); cursor: pointer; }
  .ck-row:hover, .open .ck-row { background: var(--card-2); }
  .hl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .done .hl { color: color-mix(in srgb, var(--text) 78%, var(--text-dim)); }
  .tk { width: 14px; height: 14px; border: 1px solid var(--shade-3); border-radius: 50%; display: grid; place-items: center; color: var(--paper); }
  .done .tk { background: var(--top); border-color: var(--top); }
  .car { width: 5px; height: 5px; border-right: 1.5px solid var(--text-dim); border-bottom: 1.5px solid var(--text-dim); transform: rotate(-45deg); transition: transform 0.15s, opacity 0.15s; opacity: 0.45; }
  .ck-row:hover .car, .open .car { opacity: 1; }
  .open .car { transform: rotate(45deg); }
  .ck-more { display: grid; gap: 7px; padding: 4px 8px 12px 30px; }
  .ck-full { margin: 0; font-size: 12px; line-height: 1.45; color: var(--text); }
  .ck-files { margin: 0; display: flex; flex-wrap: wrap; gap: 4px; }
  .ck-file { padding: 1px 6px; border: 1px solid var(--hair); border-radius: 4px; font-size: 10.5px; color: var(--text); }
  .ck-ev { margin: 0; font-size: 10.5px; line-height: 1.5; color: var(--text-dim); overflow-wrap: anywhere; }

  .dec { display: inline-block; margin: 2px 0 6px; font-size: 10.5px; padding: 2px 8px; border: 1px solid var(--hair); border-radius: 999px; color: var(--text-dim); }
  .slice { margin: 0 0 10px; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; }
  h4 { margin: 10px 0 4px; font-size: 9.5px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-dim); }
  .req { margin: 0; padding-left: 18px; list-style: decimal; display: grid; gap: 4px; font-size: 12px; line-height: 1.4; }
  .req li::marker { color: var(--shade-2); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10.5px; }
  .pf { margin: 0; font-size: 10.5px; color: var(--text-dim); word-break: break-all; line-height: 1.6; }

  @keyframes fade { from { opacity: 0; } }
  @keyframes in { from { transform: translateX(40px); opacity: 0; } }
  @keyframes rise { from { transform: translateY(6px); opacity: 0; } }
  @keyframes flash { 0% { opacity: 0.9; background: color-mix(in srgb, var(--accent) 24%, transparent); } 100% { opacity: 0; background: transparent; } }
  @media (prefers-reduced-motion: reduce) {
    .veil, .panel, .livechip { animation: none; }
    .flash.go { animation: none; }
  }

  @media (max-width: 760px) {
    .veil { background: color-mix(in srgb, var(--paper) 60%, transparent); }
    .panel { top: auto; left: 0; right: 0; width: 100%; height: min(92dvh, 100% - 12px); border-left: 0; border-top: 1px solid var(--hair); border-radius: 18px 18px 0 0; animation: slide 0.26s cubic-bezier(0.2, 0.8, 0.2, 1); box-shadow: 0 -20px 50px rgba(0, 0, 0, 0.45); transition: transform 0.18s ease-out ; }
    .panel.dragging { transition: none; }
    .grab { display: grid; place-items: center; height: 22px; touch-action: none; cursor: grab; }
    .grab i { width: 38px; height: 4px; border-radius: 2px; background: var(--shade-3); }
    header { padding-top: 4px; padding-left: 16px; padding-right: 16px; }
    .x { width: 44px; height: 44px; }
    .turns, .chips, .body { padding-left: 16px; padding-right: 16px; }
    .row { padding-left: 16px; padding-right: 16px; }
    .tab { min-height: 44px; }
    .chip { min-height: 32px; }
  }
  @media (max-width: 760px) and (prefers-reduced-motion: reduce) { .panel { animation: none; transition: none; } }
  @keyframes slide { from { transform: translateY(100%); } }
</style>
