<script lang="ts">
  // Sign-in over the dormant machine. One card, two fields, one button.
  import { onMount } from "svelte";
  import Machine from "./Machine.svelte";
  import { login } from "../lib/api";
  import { boot } from "../lib/stream";
  import { fmtCountdown } from "../lib/format";

  let email = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state("");
  let shake = $state(0);
  let lockUntil = $state(0);
  let now = $state(Date.now());
  const left = $derived(Math.max(0, Math.ceil((lockUntil - now) / 1000)));
  let emailEl = $state<HTMLInputElement>();

  onMount(() => {
    emailEl?.focus();
    const t = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(t);
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || left > 0) return;
    busy = true;
    error = "";
    const r = await login(email.trim(), password);
    busy = false;
    if (r.ok) { password = ""; await boot(); return; }
    shake++;
    if (r.error === "rate_limited") { lockUntil = Date.now() + (r.retryAfter ?? 60) * 1000; now = Date.now(); error = "too many attempts"; }
    else if (r.error === "network") error = "not connected";
    else error = "wrong email or password";
  }
</script>

<main class="login">
  <div class="back" aria-hidden="true"><Machine interactive={false} /></div>
  {#key shake}
    <form class="card" class:shake={shake > 0} onsubmit={submit} aria-label="Sign in">
      <h1 class="serif">factory</h1>
      <label>
        <span>email</span>
        <input bind:this={emailEl} type="email" bind:value={email} autocomplete="username" required inputmode="email" />
      </label>
      <label>
        <span>password</span>
        <input type="password" bind:value={password} autocomplete="current-password" required />
      </label>
      <p class="err mono" role="alert">{error}{#if left > 0} · retry in {fmtCountdown(left)}{/if}</p>
      <button type="submit" disabled={busy || left > 0 || !email || !password}>{busy ? "…" : "sign in"}</button>
    </form>
  {/key}
</main>

<style>
  .login { min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; position: relative; overflow: hidden; }
  .back { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0.35; pointer-events: none; }
  .back :global(svg) { width: min(1500px, 140vw); max-height: 100dvh; }
  .card { position: relative; width: min(360px, 100%); padding: 28px 26px 24px; background: color-mix(in srgb, var(--card) 92%, transparent); border: 1px solid var(--hair); border-radius: 16px; display: grid; gap: 14px; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5); backdrop-filter: blur(6px); }
  h1 { margin: 0 0 6px; font-size: 34px; font-weight: 400; text-align: center; }
  label { display: grid; gap: 6px; }
  label span { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-dim); }
  input { height: 46px; padding: 0 14px; background: var(--paper); border: 1px solid var(--hair); border-radius: 10px; font-size: 16px; }
  input:focus { outline: none; border-color: var(--accent); }
  .err { margin: 0; min-height: 18px; font-size: 12px; color: var(--text); text-align: center; }
  button { height: 48px; border-radius: 10px; border: 0; background: var(--top); color: var(--line); font-weight: 600; letter-spacing: 0.06em; font-size: 14px; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .shake { animation: shake 0.42s cubic-bezier(0.36, 0.07, 0.19, 0.97); }
  @keyframes shake { 15% { transform: translateX(-9px); } 30% { transform: translateX(8px); } 45% { transform: translateX(-6px); } 60% { transform: translateX(5px); } 80% { transform: translateX(-2px); } }
</style>
