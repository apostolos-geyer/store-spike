/**
 * The SPA build. Output lands in `console/dist`, which is the directory
 * `src/Workers/Console.ts` names as its assets directory — the two are coupled
 * by that path and nothing else, so moving one means moving the other.
 *
 * `server.proxy` only affects `vite dev`. It forwards `/api` to a locally
 * running worker so the pages can be iterated on without a deploy; the deployed
 * build never sees it, because there the worker and the assets are the same
 * Cloudflare script.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.CONSOLE_ORIGIN ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
