import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    // Product source stays under src/; all frontend unit tests live here.
    include: ['tests/**/*.spec.ts'],
  },
})
