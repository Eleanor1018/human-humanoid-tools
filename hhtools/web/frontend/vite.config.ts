import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8009'
    }
  },
  build: {
    // FastAPI and Electron both serve this directory, so one renderer build is shared.
    outDir: '../static',
    emptyOutDir: false,
    sourcemap: true
  }
})
