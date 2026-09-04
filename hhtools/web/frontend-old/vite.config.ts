import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8009",
    },
  },
  build: {
    // FastAPI and Electron serve this exact output. Host-specific capabilities
    // are injected behind the preload boundary instead of forking the renderer.
    outDir: "../static",
    emptyOutDir: false,
    sourcemap: true,
  },
});
