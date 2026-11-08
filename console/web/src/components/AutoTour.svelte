<script lang="ts">
  // Renderless. Two jobs, both outside the render path:
  //  1. the camera auto-tour (decisions in camera.svelte.ts: tourStep), applied every 250 ms;
  //  2. the sound hooks: watches the store for new tool items and stage changes and asks sound.ts to play.
  // Nothing here writes state that an $effect reads: the interval writes camera fields only, and the
  // sound watcher keeps its memory in plain variables.
  import { onMount, untrack } from "svelte";
  import { cam, lastManualAt, newTourMem, tourFit, tourFollow, tourStep } from "../lib/camera.svelte";
  import type { TourAct } from "../lib/camera.svelte";
  import { anim, settle } from "../lib/anim.svelte";
  import { store } from "../lib/store.svelte";
  import { play, setTpmSource, soundFor, unlock } from "../lib/sound";
  import type { Item, Slot } from "../lib/types";

  const mem = newTourMem(performance.now());
  let lastAct = "";

  function tick() {
    if (!cam.tour) { lastAct = ""; return; }
    const slots = store.snap.slots;
    const active = slots.map((s) => s.run_id != null && s.issue != null && (s.state === "running" || s.state === "draining"));
    const lastTool = [0, 1, 2].map((k) => store.arrivals[k].at(-1) ?? 0);
    const act: TourAct = tourStep(mem, { now: performance.now(), active, lastTool, reduced: anim.reduced, manualAt: lastManualAt() });
    const id = act.kind === "follow" ? `f${act.lane}` : act.kind;
    if (id === lastAct) return;
    lastAct = id;
    if (act.kind === "follow") tourFollow(act.lane);
    else if (act.kind === "fit") tourFit();
    if (anim.reduced) settle(); // the loop sleeps under reduced motion: pose the camera right now (an instant cut)
  }

  // ---------------------------------------------------------------- sound watcher
  let tails: (Item | null)[] | null = null;
  let seen: { run: string | null; stage: string | null }[] = [];
  function watch(activity: Record<string, Item[]>, slots: Slot[]) {
    if (!store.ready) return;
    if (tails === null) {
      tails = [0, 1, 2].map((k) => activity[String(k + 1)]?.at(-1) ?? null);
      seen = slots.map((s) => ({ run: s.run_id, stage: s.stage }));
      return;
    }
    for (let k = 0; k < 3; k++) {
      const arr = activity[String(k + 1)] ?? [];
      const tail = tails[k];
      const at = tail ? arr.lastIndexOf(tail) : -1;
      // tail not found = a reset or a fresh snapshot: resync silently
      const fresh = tail == null ? arr : at >= 0 ? arr.slice(at + 1) : [];
      tails[k] = arr.at(-1) ?? null;
      for (const it of fresh.slice(-4)) { const s = soundFor(it); if (s) play(s); }
      const sl = slots[k], was = seen[k];
      if (sl.run_id != null && sl.run_id === was.run && sl.stage !== was.stage) {
        if (sl.stage === "merge") play("chime");
        else if (sl.stage === "live") play("gong");
      }
      seen[k] = { run: sl.run_id, stage: sl.stage };
    }
  }
  $effect(() => {
    const snap = store.snap;
    untrack(() => watch(snap.activity, snap.slots));
  });

  onMount(() => {
    setTpmSource(() => store.tokensPerMin());
    const iv = setInterval(tick, 250);
    const gesture = () => unlock();
    window.addEventListener("pointerdown", gesture, { passive: true });
    window.addEventListener("keydown", gesture);
    return () => {
      clearInterval(iv);
      window.removeEventListener("pointerdown", gesture);
      window.removeEventListener("keydown", gesture);
    };
  });
</script>
