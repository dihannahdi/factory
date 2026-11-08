<script lang="ts">
  // The holding rack beside the infeed. Blocked issues are ingots chained to the tags they wait for,
  // issues already taken by a human PR sit on a separate shelf, failed ones in the scrap bin.
  import Faces from "./Faces.svelte";
  import { box, line3, plate, prism, rotBox, topMatrix } from "../lib/iso";
  import type { Face } from "../lib/iso";
  import { store } from "../lib/store.svelte";

  const issues = $derived(store.snap.github?.issues ?? []);
  const blocked = $derived(issues.filter((i) => i.class === "blocked").slice(0, 3));
  const blockedN = $derived(issues.filter((i) => i.class === "blocked").length);
  const taken = $derived(issues.filter((i) => i.class === "taken"));
  const failed = $derived(issues.filter((i) => i.class === "failed"));
  const tagOf = (n: number): string => issues.find((i) => i.n === n)?.tag ?? `#${n}`;

  const X0 = -13.4;
  const trayB = $derived<Face[]>(box(X0, -5.2, 0, 8.6, 5.4, 0.35, { top: "s3", left: "s2", right: "s3" }));
  const trayT = $derived<Face[]>(box(X0, 0.9, 0, 8.6, 3.2, 0.35, { top: "s3", left: "s2", right: "s3" }));
  const bin = $derived<Face[]>([
    ...box(X0, 5.1, 0, 4.2, 3.2, 1.0, { top: "s2", left: "s2", right: "s3" }),
    plate(X0 + 0.35, 5.45, 1.003, 3.5, 2.5, "s4"),
  ]);
  const scrap = $derived.by(() => {
    const out: Face[] = [];
    const n = Math.min(failed.length, 5);
    for (let i = 0; i < n; i++) out.push(...rotBox(X0 + 0.9 + (i % 3) * 1.1, 6.0 + Math.floor(i / 3) * 1.0, 1.0, 1.5, 0.5, 0.35, 0.5 + i * 1.3, { top: "s1" }));
    return out;
  });

  const rows = $derived.by(() => {
    return blocked.map((b, i) => {
      const x = X0 + 0.7 + i * 2.75;
      const deps = b.deps.slice(0, 2);
      const plates = deps.map((d, j) => ({
        tag: tagOf(d),
        f: box(x + 0.15, -4.7 + j * 1.45 - 0.0, 0.35, 2.3, 1.05, 0.28, { top: "s1" }),
        y: -4.7 + j * 1.45 + 0.52,
        x: x + 1.3,
      }));
      return {
        tag: b.tag ?? `#${b.n}`,
        f: box(x, -0.3, 0.35, 2.5, 1.35, 0.6, { top: "top" }),
        x: x + 1.25,
        chain: plates.map((p) => line3([[p.x, p.y + 0.55, 0.65], [x + 1.25, -0.3, 0.95]])).join(""),
        plates,
      };
    });
  });
  const takenFaces = $derived.by(() => {
    const out: Face[] = [];
    const n = Math.min(taken.length, 6);
    for (let i = 0; i < n; i++) {
      const x = X0 + 0.5 + (i % 3) * 2.75, y = 1.4 + Math.floor(i / 3) * 1.55;
      out.push(...box(x, y, 0.35, 2.4, 1.2, 0.5, { top: "s1" }));
      out.push(...prism([[x + 0.2, y + 0.1], [x + 0.2, y + 1.1], [x + 0.9, y + 0.6]], 0.85, 0.05, { top: "top" }));
    }
    return out;
  });
</script>

<g class="rack">
  <Faces faces={trayB} />
  <Faces faces={trayT} />
  <Faces faces={bin} />
  <Faces faces={scrap} />
  {#each rows as r, i (i)}
    <Faces faces={r.f} />
    <path d={r.chain} class="chain" />
    <text class="tag" transform={topMatrix(r.x, 0.43, 0.96)} font-size="0.6" text-anchor="middle" dominant-baseline="central">{r.tag}</text>
    {#each r.plates as p, j (j)}
      <Faces faces={p.f} />
      <text class="tag" transform={topMatrix(p.x, p.y, 0.64)} font-size="0.56" text-anchor="middle" dominant-baseline="central">{p.tag}</text>
    {/each}
  {/each}
  <Faces faces={takenFaces} />
  <text class="eng" transform={topMatrix(X0 + 0.1, -5.5, 0.01)} font-size="0.62">blocked {blockedN}</text>
  <text class="eng" transform={topMatrix(X0 + 0.1, 4.45, 0.01)} font-size="0.62">taken {taken.length}</text>
  <text class="eng" transform={topMatrix(X0 + 0.1, 8.65, 0.01)} font-size="0.62">failed {failed.length}</text>
</g>

<style>
  .chain { fill: none; stroke: var(--line); stroke-width: 1; stroke-dasharray: 1.5 2.5; vector-effect: non-scaling-stroke; }
  .tag { fill: var(--line); font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; font-weight: 600; }
  .eng { fill: var(--text-dim); font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; opacity: 0.7; letter-spacing: 0.04em; }
</style>
