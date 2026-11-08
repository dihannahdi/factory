/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { mockApi } from "./dev/mock-api";

// The production bundle never sees dev/mock-api.ts: the plugin is only added for `vite serve`.
export default defineConfig(({ command }) => ({
  plugins: [svelte(), ...(command === "serve" ? [mockApi()] : [])],
  build: {
    outDir: "../public",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0, // CSP is 'self': no data: URIs for fonts or images
    sourcemap: false,
    chunkSizeWarningLimit: 400,
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
}));
