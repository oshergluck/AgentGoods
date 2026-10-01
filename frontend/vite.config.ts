import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * MASTER_PLAN 0.27.AC: contract addresses and chain ids are public, but the frontend reads
 * them from the runtime manifest served by the API rather than baking them into the bundle,
 * so a Registry or UltraShop implementation upgrade does not require a frontend rebuild.
 * The only build-time value is the API base URL.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { react: ["react", "react-dom", "react-router-dom"] },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.VITE_API_URL ?? "http://127.0.0.1:4000", changeOrigin: true },
      "/.well-known": { target: process.env.VITE_API_URL ?? "http://127.0.0.1:4000", changeOrigin: true },
    },
  },
});
