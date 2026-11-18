import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  publicDir: false,
  optimizeDeps: { entries: ['index.html'] },
  server: {
    fs: {
      strict: true,
      allow: [resolve('src'), resolve('node_modules'), resolve('index.html')],
    },
  },
  build: { outDir: 'dist' },
})
